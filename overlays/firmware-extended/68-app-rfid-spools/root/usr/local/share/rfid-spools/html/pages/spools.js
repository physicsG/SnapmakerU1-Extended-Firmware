'use strict';

// ── Spools page ─────────────────────────────────────────────────────────────
// Renders the 4-channel spool grid. Tag updates are pushed via SSE.

var SpoolsPage = (function () {

    var _unsubscribeScan = null;       // OpenRfid.onScan unsubscribe handle
    var _unsubscribeStatus = null;     // notify_status_update unsubscribe handle
    var _spoolmanCache = {};           // channel → filament record
    var _spoolmanFetchPending = false; // prevents overlapping refresh batches
    var _uidSyncIndex = {};            // uid (UPPERCASE) → {spool_id,filament_id,name,density}
    var _spoolmanSpoolsCache = [];     // raw Spoolman spool list, refreshed alongside the index
    var _uidSyncIndexTs = 0;           // last refresh epoch ms; 0 = never
    var _uidSyncRefreshing = null;     // in-flight Promise (deduped)
    var _UID_INDEX_TTL_MS = 30 * 1000;
    var _editingChannels = {};         // channel → true if user is editing inline
    var _writeEnabled = false;         // mirrors openrfid/list_channels.write_enabled
    var _filamentDetect = {};          // last printer.objects.query result for filament_detect
    var _channels = [];                // last openrfid/list_channels.channels (per-slot)
    var _spoolListCache = null;        // {ts, items, truncated, archived}
    var _SPOOL_LIST_TTL_MS = 60 * 1000;

    // Density defaults (g/cm³) by material type — mirrors backend MATERIAL_DENSITY table.
    var DENSITY_DEFAULTS = {
        'PLA': 1.24, 'PLA+': 1.24,
        'ABS': 1.05, 'ASA': 1.07,
        'PETG': 1.27, 'PET': 1.27,
        'TPU': 1.21, 'TPE': 1.21, 'FLEX': 1.21,
        'PA': 1.12, 'NYLON': 1.12,
        'PC': 1.20, 'HIPS': 1.05,
        'PVA': 1.23, 'PP': 0.91
    };

    function defaultDensity(material) {
        if (!material) return 1.24;
        var key = String(material).toUpperCase().split(/[\s\-\/]/)[0];
        return DENSITY_DEFAULTS[key] || 1.24;
    }

    function resolveFields(ch, _config) {
        var mk = ch.moonraker || {};
        var tag = ch.tag || null;
        var filament = (tag && tag.filament) ? tag.filament : null;

        // Determine processor key (kept for legacy callers — still consumed
        // by the tag-type badge logic in renderChannel).
        var processorKey = 'generic';
        if (filament && filament.source_processor) {
            var proc = filament.source_processor;
            if (proc === 'tigertag_tag_processor') processorKey = 'tigertag';
            else if (proc === 'snapmaker_tag_processor') processorKey = 'snapmaker';
        } else if (mk.CARD_UID && Array.isArray(mk.CARD_UID)) {
            if (mk.CARD_UID.length === 4) processorKey = 'snapmaker';
        }

        function fromFilamentOr(field, mkField, fallback) {
            if (filament && filament[field] !== undefined && filament[field] !== null) return filament[field];
            if (mkField !== undefined && isMk(mk[mkField])) return mk[mkField];
            return fallback === undefined ? null : fallback;
        }

        var msg = (filament && typeof filament.message === 'string') ? filament.message.trim() : '';

        return {
            manufacturer:       fromFilamentOr('manufacturer', 'VENDOR'),
            type:               fromFilamentOr('type', 'MAIN_TYPE'),
            modifiers:          filament ? filament.modifiers : (isMk(mk.SUB_TYPE) ? [mk.SUB_TYPE] : []),
            colors:             filament ? filament.colors : null,
            rgb1:               mk.RGB_1,
            hotend_min_temp_c:  fromFilamentOr('hotend_min_temp_c', 'HOTEND_MIN_TEMP'),
            hotend_max_temp_c:  fromFilamentOr('hotend_max_temp_c', 'HOTEND_MAX_TEMP'),
            bed_temp_c:         fromFilamentOr('bed_temp_c', 'BED_TEMP'),
            bed_temp_min_c:     filament ? filament.bed_temp_min_c : null,
            bed_temp_max_c:     filament ? filament.bed_temp_max_c : null,
            first_layer_temp:   mk.FIRST_LAYER_TEMP,
            other_layer_temp:   mk.OTHER_LAYER_TEMP,
            diameter_mm:        fromFilamentOr('diameter_mm', 'DIAMETER'),
            weight_grams:       fromFilamentOr('weight_grams', 'WEIGHT'),
            drying_temp_c:      fromFilamentOr('drying_temp_c', 'DRYING_TEMP'),
            drying_time_hours:  fromFilamentOr('drying_time_hours', 'DRYING_TIME'),
            manufacturing_date: (filament && filament.manufacturing_date) ? filament.manufacturing_date : mk.MF_DATE,
            td:                 filament ? filament.td : null,
            message:            msg || null,
            uid:                (tag && tag.scan && tag.scan.uid) ? tag.scan.uid : mk.CARD_UID,
            processorKey:       processorKey,
        };
    }

    function renderChannel(ch, config) {
        var mk = ch.moonraker || {};
        var tag = ch.tag || null;
        var slotNames = (config && config.slot_names) || {};
        var slotNotes = (config && config.slot_notes) || {};
        var defaultNames = ['Slot 1 (Top-Left)', 'Slot 2 (Bottom-Left)', 'Slot 3 (Top-Right)', 'Slot 4 (Bottom-Right)'];

        var f = resolveFields(ch, config);

        var card = Templates.clone('channel-card');
        card.setAttribute('data-channel', String(ch.channel));

        var header = Templates.$(card, '[data-id="header"]');
        var body = Templates.$(card, '[data-id="body"]');
        var footers = Templates.$(card, '[data-id="footers"]');

        Templates.setText(card, '[data-id="name"]',
            slotNames[ch.channel] || slotNames[String(ch.channel)] || defaultNames[ch.channel] || ('Slot ' + (ch.channel + 1)));

        var note = slotNotes[ch.channel] || slotNotes[String(ch.channel)] || '';
        var noteEl = Templates.$(card, '[data-id="note"]');
        if (note && note.trim()) {
            noteEl.textContent = note.trim();
            noteEl.hidden = false;
        }

        // Tag type badge
        var tagTypeName = null;
        var isUnrecognized = !!(tag && tag.unrecognized && !tag.filament);
        if (tag && tag.filament && tag.filament.source_processor) {
            var proc = tag.filament.source_processor;
            if (proc === 'tigertag_tag_processor') tagTypeName = 'TigerTag';
            else if (proc === 'snapmaker_tag_processor') tagTypeName = 'Snapmaker';
            else if (proc === 'openspool_tag_processor') tagTypeName = 'OpenSpool';
            else tagTypeName = proc.replace(/_tag_processor$/, '');
        } else if (isUnrecognized) {
            tagTypeName = 'Blank';
        } else if (mk.CARD_UID && Array.isArray(mk.CARD_UID)) {
            if (mk.CARD_UID.length === 4) tagTypeName = 'Snapmaker';
            else if (mk.CARD_UID.length === 7) tagTypeName = 'TigerTag';
        }
        if (tagTypeName) {
            var badge = Templates.clone('channel-tag-type-badge');
            badge.textContent = tagTypeName;
            header.appendChild(badge);
        }

        // Body
        var hasData = isMk(mk.VENDOR) || isMk(mk.MAIN_TYPE) || (tag && tag.filament);

        if (!hasData && isUnrecognized) {
            var unrec = Templates.clone('channel-unrecognized');
            var uidEl = Templates.$(unrec, '[data-id="uid"]');
            var rawUid = (tag.scan && tag.scan.uid) || '';
            uidEl.textContent = Array.isArray(rawUid) ? formatUid(rawUid) : String(rawUid);
            body.appendChild(unrec);
        } else if (!hasData) {
            body.appendChild(Templates.clone('channel-empty'));
        } else {
            var fields = [];

            addField(fields, 'Vendor', f.manufacturer);
            addField(fields, 'Material', f.type);

            var mods = f.modifiers;
            if (mods && (Array.isArray(mods) ? mods.length > 0 : mods)) {
                addField(fields, 'Subtype', Array.isArray(mods) ? mods.join(', ') : mods);
            }

            // Color
            var colorHex = null;
            var colorSrc = f.colors;
            if (Array.isArray(colorSrc) && colorSrc.length > 0) {
                var argb = colorSrc[0];
                var r = (argb >> 16) & 0xFF;
                var g = (argb >> 8) & 0xFF;
                var b = argb & 0xFF;
                colorHex = '#' + ('0' + r.toString(16)).slice(-2) + ('0' + g.toString(16)).slice(-2) + ('0' + b.toString(16)).slice(-2);
            } else if (typeof colorSrc === 'number') {
                colorHex = colorToHex(colorSrc);
            } else if (typeof colorSrc === 'string' && colorSrc) {
                colorHex = colorSrc.startsWith('#') ? colorSrc : '#' + colorSrc;
            } else if (f.rgb1 !== undefined && f.rgb1 !== null && f.rgb1 !== 16777215) {
                colorHex = colorToHex(f.rgb1);
            }
            if (colorHex) {
                fields.push({ label: 'Color', value: createColorSwatch(colorHex), raw: true });
            }

            // Nozzle temps
            var minTemp = f.hotend_min_temp_c;
            var maxTemp = f.hotend_max_temp_c;
            if (minTemp || maxTemp) {
                fields.push({
                    label: 'Nozzle',
                    value: '<span class="temp-range">' + escapeHtml(minTemp || '?') + '–' + escapeHtml(maxTemp || '?') + ' °C</span>',
                    raw: true
                });
            }

            // Bed temps. Some tags (Snapmaker, OpenSpool, Qidi) only carry a
            // single bed-temp value while TigerTag has a min/max pair. Fall
            // back across all three slots so a single value still renders.
            var bedMin = f.bed_temp_min_c;
            var bedMax = f.bed_temp_max_c;
            var bedTemp = f.bed_temp_c;
            if (!(bedTemp > 0)) bedTemp = bedMin || bedMax || null;
            if (!(bedMin > 0)) bedMin = bedTemp;
            if (!(bedMax > 0)) bedMax = bedTemp;
            if (bedMin && bedMax && bedMin > 0 && bedMax > 0 && bedMin !== bedMax) {
                fields.push({
                    label: 'Bed',
                    value: '<span class="temp-range">' + escapeHtml(Math.round(bedMin)) + '–' + escapeHtml(Math.round(bedMax)) + ' °C</span>',
                    raw: true
                });
            } else if (bedTemp && bedTemp > 0) {
                fields.push({
                    label: 'Bed',
                    value: '<span class="temp-range">' + escapeHtml(Math.round(bedTemp)) + ' °C</span>',
                    raw: true
                });
            }

            // First/other layer temps (Snapmaker raw fields)
            if (f.first_layer_temp && f.first_layer_temp > 0) {
                fields.push({ label: 'First Layer', value: '<span class="temp-range">' + escapeHtml(f.first_layer_temp) + ' °C</span>', raw: true });
            }
            if (f.other_layer_temp && f.other_layer_temp > 0) {
                fields.push({ label: 'Other Layers', value: '<span class="temp-range">' + escapeHtml(f.other_layer_temp) + ' °C</span>', raw: true });
            }

            if (f.diameter_mm && f.diameter_mm > 0) addField(fields, 'Diameter', f.diameter_mm + ' mm');
            if (f.weight_grams && f.weight_grams > 0) addField(fields, 'Weight', f.weight_grams + ' g');

            var dryTemp = f.drying_temp_c;
            var dryTime = f.drying_time_hours;
            if (dryTemp && dryTemp > 0) {
                var dryStr = dryTemp + ' °C';
                if (dryTime && dryTime > 0) dryStr += ' / ' + dryTime + ' h';
                fields.push({ label: 'Drying', value: '<span class="temp-range">' + escapeHtml(dryStr) + '</span>', raw: true });
            }

            var mfDate = f.manufacturing_date;
            if (mfDate && mfDate !== '19700101' && mfDate !== '0001-01-01' && mfDate !== 'NONE' && mfDate !== '') {
                if (typeof mfDate === 'string' && mfDate.length === 8) {
                    mfDate = mfDate.slice(0, 4) + '-' + mfDate.slice(4, 6) + '-' + mfDate.slice(6, 8);
                }
                addField(fields, 'Mfg Date', mfDate);
            }

            if (f.td && f.td > 0) addField(fields, 'TD', f.td + ' mm');

            if (f.message) addField(fields, 'Message', f.message);

            // UID
            var uid = f.uid;
            if (uid && uid !== 0) {
                var uidStr = Array.isArray(uid) ? formatUid(uid) : escapeHtml(uid);
                fields.push({ label: 'UID', value: '<span class="uid-value">' + uidStr + '</span>', raw: true });
            }

            // Render field grid
            var grid = Templates.clone('channel-field-grid');
            for (var i = 0; i < fields.length; i++) {
                var row = Templates.cloneFragment('channel-field-row');
                Templates.setText(row, '[data-id="label"]', fields[i].label);
                var fv = Templates.$(row, '[data-id="value"]');
                if (fields[i].raw) fv.innerHTML = fields[i].value;
                else fv.textContent = fields[i].value;
                grid.appendChild(row);
            }
            body.appendChild(grid);
        }

        // ── Inline edit / write footer (writable NTAG215 tags only) ─────────
        // Detect writability by UID length: 7 bytes = NTAG215/Ultralight (writable),
        // 4 bytes = Mifare Classic (Snapmaker, read-only here). UID may arrive as
        // a hex string from openrfid scan or a byte array from Moonraker mk.
        var uidVal = (tag && tag.scan && tag.scan.uid) ? tag.scan.uid : mk.CARD_UID;
        var uidByteLen = 0;
        if (Array.isArray(uidVal)) {
            uidByteLen = uidVal.length;
        } else if (typeof uidVal === 'string') {
            uidByteLen = Math.floor(uidVal.replace(/[^0-9a-fA-F]/g, '').length / 2);
        }
        var isWritable = uidByteLen === 7;
        // Hide all write/clear/edit affordances when the firmware-config
        // toggle (`components.rfid_write`) is off — that's the master kill
        // switch piped through to openrfid_api.enable_write. The agent
        // would refuse the call anyway, but suppressing the buttons keeps
        // the UI honest about what's available.
        if (isWritable && _writeEnabled) {
            if (isUnrecognized) {
                // Blank tag: 3-button action group — write defaults, pick a
                // Spoolman spool, or enter a spool ID directly.
                var blankFooter = Templates.clone('channel-blank-actions');
                var writeBlankBtn = Templates.$(blankFooter, '[data-id="write-blank"]');
                var fromSpoolmanBtn = Templates.$(blankFooter, '[data-id="from-spoolman"]');
                var byIdBtn = Templates.$(blankFooter, '[data-id="by-id"]');

                writeBlankBtn.addEventListener('click', function () {
                    ensureRegistry().then(function (reg) {
                        enterEditMode(card, ch, config, f, reg, true);
                    }).catch(function (err) {
                        alert('Failed to load TigerTag registry: ' + err.message);
                    });
                });

                // Hide Spoolman-aware buttons unless Spoolman is actually
                // configured (and presumed reachable). The dialog itself
                // surfaces a clear error if the network call fails.
                if (config && config.spoolman_url) {
                    fromSpoolmanBtn.addEventListener('click', function () {
                        openSpoolPicker(card, ch, config);
                    });
                    byIdBtn.addEventListener('click', function () {
                        promptByIdAndPrefill(card, ch, config);
                    });
                } else {
                    fromSpoolmanBtn.hidden = true;
                    byIdBtn.hidden = true;
                }

                footers.appendChild(blankFooter);
            } else {
                // Recognized writable tag: keep the original single Edit button.
                var editFooter = Templates.clone('channel-edit-footer');
                var editBtn = Templates.$(editFooter, '[data-id="edit-btn"]');
                editBtn.addEventListener('click', function () {
                    ensureRegistry().then(function (reg) {
                        enterEditMode(card, ch, config, f, reg, false);
                    }).catch(function (err) {
                        alert('Failed to load TigerTag registry: ' + err.message);
                    });
                });
                footers.appendChild(editFooter);
            }
        }

        // Spoolman sync footer (shown when spoolman_url is configured and tag present)
        var spoolmanUrl = config && config.spoolman_url;
        if (spoolmanUrl && hasData && tag && tag.filament) {
            var spoolmanFooter = Templates.clone('channel-spoolman-footer');
            var badgeSlot = Templates.$(spoolmanFooter, '[data-id="badge-slot"]');
            var bodySlot = Templates.$(spoolmanFooter, '[data-id="body"]');

            var syncState = ch.spoolman_sync;
            var channelIndex = ch.channel;

            var isLinked = !!(syncState && syncState.filament_id);
            var cached = isLinked ? _spoolmanCache[channelIndex] : null;
            var cacheValid = !!(cached && cached.filament_id === syncState.filament_id);

            if (isLinked && cacheValid) {
                var syncBadge = Templates.clone('spoolman-sync-badge');
                var badgeLink = Templates.$(syncBadge, '[data-id="link"]');
                var unlinkBtn = Templates.$(syncBadge, '[data-id="unlink"]');
                badgeLink.href = spoolmanUrl.replace(/\/$/, '') + '/filament/show/' + syncState.filament_id;
                var badgeParts = ['Synced \u2713 \u00b7 Filament #' + syncState.filament_id];
                if (syncState.spool_id) badgeParts.push('Spool #' + syncState.spool_id);
                badgeLink.textContent = badgeParts.join(' \u00b7 ');
                unlinkBtn.addEventListener('click', function () {
                    unlinkChannel(channelIndex, syncState.spool_id, unlinkBtn);
                });
                badgeSlot.replaceWith(syncBadge);
            }

            var cacheError = isLinked && !!(cached && cached.error === true);
            var isLoading = isLinked && !cacheValid && !cacheError;

            if (isLoading) {
                bodySlot.appendChild(Templates.clone('spoolman-sync-body-loading'));
            } else if (cacheError) {
                bodySlot.appendChild(Templates.clone('spoolman-sync-body-error'));
            } else {
                var form = Templates.clone('spoolman-sync-body-form');
                var nameInput = Templates.$(form, '[data-id="name-input"]');
                var densityInput = Templates.$(form, '[data-id="density-input"]');
                var syncBtn = Templates.$(form, '[data-id="sync-btn"]');
                var syncStatus = Templates.$(form, '[data-id="status"]');

                // Pre-fill the name field. The tag's `Message` (TigerTag's
                // free-text product label) wins over Spoolman's filament
                // name so a freshly-written tag with a custom Message
                // surfaces it on import; only fall back to the cached
                // Spoolman name when the tag has no message at all.
                if (f.message) {
                    nameInput.value = f.message;
                } else if (cacheValid && cached.name) {
                    nameInput.value = cached.name;
                }
                densityInput.value = (cacheValid && cached.density) ? cached.density : defaultDensity(f.type);
                syncBtn.textContent = isLinked ? 'Sync \u2197' : 'Import to Spoolman \u2197';

                var linkedFilamentId = cacheValid ? cached.filament_id : null;
                syncBtn.addEventListener('click', function () {
                    syncToSpoolman(channelIndex, nameInput, densityInput, syncStatus, syncBtn, linkedFilamentId);
                });

                // Suggestion list: only when not linked yet. Filters out
                // any spool already carrying *this* channel's UID so we
                // don't suggest the spool the badge is already showing.
                if (!isLinked) {
                    var suggestionsSlot = Templates.$(form, '[data-id="suggestions-slot"]');
                    if (suggestionsSlot) {
                        var rawUid = (ch.tag && ch.tag.scan && ch.tag.scan.uid) || (ch.moonraker && ch.moonraker.CARD_UID);
                        var uidStrSugg = Array.isArray(rawUid) ? formatUid(rawUid) : (rawUid ? String(rawUid) : null);
                        var matches = findSpoolMatches(f, uidStrSugg ? [uidStrSugg] : []);
                        if (matches.length) {
                            var sugBox = Templates.clone('spoolman-suggestions');
                            var sugList = Templates.$(sugBox, '[data-id="list"]');
                            matches.forEach(function (m) {
                                var row = Templates.clone('spoolman-suggestion-row');
                                var fil = m.spool.filament || {};
                                var vendor = (fil.vendor && fil.vendor.name) || '';
                                var name = fil.name || ('Spool #' + m.spool.id);
                                var swatch = Templates.$(row, '[data-id="swatch"]');
                                if (fil.color_hex) swatch.style.background = '#' + fil.color_hex;
                                Templates.$(row, '[data-id="name"]').textContent = name;
                                var metaParts = [];
                                if (vendor) metaParts.push(vendor);
                                if (fil.material) metaParts.push(fil.material);
                                metaParts.push('#' + m.spool.id);
                                if (m.reasons.length) metaParts.push(m.reasons.join(', '));
                                Templates.$(row, '[data-id="meta"]').textContent = metaParts.join(' \u00b7 ');
                                var linkBtn = Templates.$(row, '[data-id="link-btn"]');
                                linkBtn.addEventListener('click', function () {
                                    linkExistingSpool(channelIndex, m.spool, syncStatus, linkBtn);
                                });
                                sugList.appendChild(row);
                            });
                            suggestionsSlot.appendChild(sugBox);
                        }
                    }
                }

                bodySlot.appendChild(form);
            }

            footers.appendChild(spoolmanFooter);
        } else if (!spoolmanUrl && hasData && tag && tag.filament) {
            // Onboarding: no Spoolman configured yet
            var onboardFooter = Templates.clone('channel-spoolman-onboard');
            var onboardLink = Templates.$(onboardFooter, '[data-id="link"]');
            onboardLink.addEventListener('click', function (e) {
                e.preventDefault();
                App.navigate('config-spoolman');
            });
            footers.appendChild(onboardFooter);
        }

        return card;
    }

    // ── TigerTag inline edit / write helpers ───────────────────────────────

    function ensureRegistry() {
        return TigerTag.loadRegistry();
    }

    function _selectFromRegistry(records, currentLabel, placeholder) {
        // `placeholder` is accepted for API compatibility but no longer rendered:
        // the user prefers seeing actual registry values in the dropdown rather
        // than a 'Select X…' hint. The first sorted entry becomes the default
        // when there is no `currentLabel` and no match.
        void placeholder;
        var sel = document.createElement('select');
        sel.className = 'channel-edit-input channel-edit-select';
        var labels = [];
        for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (!r) continue;
            // Accept either `label` (most TigerTag DB files) or `name` (id_brand.json).
            var lab = (typeof r.label === 'string') ? r.label
                    : (typeof r.name === 'string') ? r.name
                    : null;
            if (!lab) continue;
            labels.push(lab);
        }
        labels.sort(function (a, b) { return a.localeCompare(b); });
        var matched = false;
        var currentLower = currentLabel ? String(currentLabel).toLowerCase() : '';
        for (var j = 0; j < labels.length; j++) {
            var o = document.createElement('option');
            o.value = labels[j];
            o.textContent = labels[j];
            if (currentLower && currentLower === labels[j].toLowerCase()) {
                o.selected = true;
                matched = true;
            }
            sel.appendChild(o);
        }
        // If the current value does not match any registry entry, surface it
        // as a custom option so the user can see and re-select it.
        if (!matched && currentLabel) {
            var custom = document.createElement('option');
            custom.value = String(currentLabel);
            custom.textContent = String(currentLabel) + ' (custom)';
            custom.selected = true;
            sel.appendChild(custom);
        }
        return sel;
    }

    function _addRow(grid, labelText, control) {
        var row = Templates.cloneFragment('tag-edit-row');
        Templates.setText(row, '[data-id="label"]', labelText);
        var wrap = Templates.$(row, '[data-id="value"]');
        wrap.appendChild(control);
        grid.appendChild(row);
        return control;
    }

    // Prepend a "None" option to a registry-backed <select>. Used for
    // blank/unrecognized tags where Material/Brand should start unset
    // rather than auto-picking the first sorted registry entry. If the
    // select already has an explicitly selected option (e.g. a Spoolman
    // pre-fill), we leave that selection alone—only force "None" when
    // nothing else has been chosen.
    function _prependNoneOption(sel) {
        if (!sel) return;
        var hadSelection = false;
        for (var k = 0; k < sel.options.length; k++) {
            if (sel.options[k].selected) { hadSelection = true; break; }
        }
        var none = document.createElement('option');
        none.value = '';
        none.textContent = 'None';
        sel.insertBefore(none, sel.firstChild);
        if (!hadSelection) {
            for (var i = 0; i < sel.options.length; i++) {
                sel.options[i].selected = (i === 0);
            }
            sel.value = '';
        }
    }

    // Resolve a numeric input default. For an already-written tag we honour
    // the on-tag value verbatim (including a deliberate 0); only fall back to
    // `defaultVal` when the field is missing entirely. For a blank tag the
    // default is always 0 so the user is forced to pick a real value.
    function _numericFieldDefault(value, isBlank, defaultVal) {
        // Honor any explicit value first — this matters when a "blank" tag
        // is being pre-filled from a Spoolman spool: isBlank is true (we're
        // about to write the tag from scratch) but the spec carries real
        // numbers we want to keep. Only when no value is supplied do we
        // distinguish blank-tag (start at 0) from recognized-tag default.
        if (value !== undefined && value !== null && value !== '') return value;
        if (isBlank) return 0;
        return defaultVal;
    }

    function _firstColorHexFromFields(f) {
        var src = f.colors;
        if (Array.isArray(src) && src.length > 0 && typeof src[0] === 'number') {
            var argb = src[0];
            var r = (argb >> 16) & 0xFF, g = (argb >> 8) & 0xFF, b = argb & 0xFF;
            return '#' + ('0' + r.toString(16)).slice(-2)
                + ('0' + g.toString(16)).slice(-2)
                + ('0' + b.toString(16)).slice(-2);
        }
        if (typeof src === 'string' && src) return src.startsWith('#') ? src : '#' + src;
        if (typeof f.rgb1 === 'number') {
            var r2 = (f.rgb1 >> 16) & 0xFF, g2 = (f.rgb1 >> 8) & 0xFF, b2 = f.rgb1 & 0xFF;
            return '#' + ('0' + r2.toString(16)).slice(-2)
                + ('0' + g2.toString(16)).slice(-2)
                + ('0' + b2.toString(16)).slice(-2);
        }
        return '#cccccc';
    }

    function _ensureEditModal() {
        var existing = document.getElementById('tag-edit-modal');
        if (existing) return existing;
        var overlay = Templates.clone('tag-edit-modal');
        document.body.appendChild(overlay);
        var closeBtn = Templates.$(overlay, '[data-id="close"]');
        // Close on overlay click (but not when clicking inside the dialog).
        overlay.addEventListener('click', function (ev) {
            if (ev.target === overlay) _closeEditModal();
        });
        closeBtn.addEventListener('click', _closeEditModal);
        // Esc to close
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && overlay.style.display !== 'none') {
                _closeEditModal();
            }
        });
        return overlay;
    }

    function _openEditModal(channel, titleText) {
        var overlay = _ensureEditModal();
        overlay.dataset.channel = String(channel);
        var title = Templates.$(overlay, '[data-id="title"]');
        if (title && titleText) title.textContent = titleText;
        var body = Templates.$(overlay, '[data-id="body"]');
        if (body) body.innerHTML = '';
        overlay.style.display = 'flex';
        document.body.classList.add('tag-edit-open');
        return body;
    }

    function _closeEditModal() {
        var overlay = document.getElementById('tag-edit-modal');
        if (!overlay) return;
        var ch = overlay.dataset.channel;
        overlay.style.display = 'none';
        document.body.classList.remove('tag-edit-open');
        if (ch != null) {
            delete _editingChannels[String(ch)];
            if (typeof fetchChannels === 'function') fetchChannels();
        }
    }

    // ── Spool picker modal ─────────────────────────────────────────────────
    // Module-level state for the picker. Holds the most recent fetch result
    // so the search input can filter without re-hitting the backend.
    var _pickerState = {
        spools: [],          // last list returned by /api/spoolman-spools
        truncated: false,
        archived: false,     // mirrors the checkbox; sent as query param
        target: null,        // { card, ch, config } captured on open
        searchTimer: null
    };

    function _ensureSpoolPicker() {
        var existing = document.getElementById('spool-picker-modal');
        if (existing) return existing;
        var overlay = Templates.clone('spool-picker-modal');
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function (ev) {
            if (ev.target === overlay) _closeSpoolPicker();
        });
        Templates.$(overlay, '[data-id="close"]').addEventListener('click', _closeSpoolPicker);
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && overlay.style.display !== 'none') {
                _closeSpoolPicker();
            }
        });

        var search = Templates.$(overlay, '[data-id="search"]');
        search.addEventListener('input', function () {
            // Debounce so very fast typists don't repaint on every keystroke.
            if (_pickerState.searchTimer) clearTimeout(_pickerState.searchTimer);
            _pickerState.searchTimer = setTimeout(_renderPickerList, 120);
        });

        var archived = Templates.$(overlay, '[data-id="archived"]');
        archived.addEventListener('change', function () {
            _pickerState.archived = !!archived.checked;
            _loadPickerSpools(false);
        });

        var refresh = Templates.$(overlay, '[data-id="refresh"]');
        refresh.addEventListener('click', function () {
            _loadPickerSpools(true);
        });

        var byIdGo = Templates.$(overlay, '[data-id="by-id-go"]');
        var byIdInput = Templates.$(overlay, '[data-id="by-id-input"]');
        function submitById() {
            var raw = byIdInput.value.trim();
            if (!raw) return;
            var n = parseInt(raw, 10);
            if (!isFinite(n) || n <= 0) {
                _setPickerStatus('Enter a positive spool ID.', true);
                return;
            }
            _useSpoolId(n);
        }
        byIdGo.addEventListener('click', submitById);
        byIdInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); submitById(); }
        });

        return overlay;
    }

    function openSpoolPicker(card, ch, config) {
        _pickerState.target = { card: card, ch: ch, config: config };
        var overlay = _ensureSpoolPicker();
        // Reset transient UI state but keep the cached list — the server
        // already caches for 60 s so re-opening should feel instant.
        Templates.$(overlay, '[data-id="search"]').value = '';
        Templates.$(overlay, '[data-id="by-id-input"]').value = '';
        Templates.$(overlay, '[data-id="archived"]').checked = _pickerState.archived;
        _setPickerStatus('', false);
        overlay.style.display = 'flex';
        document.body.classList.add('tag-edit-open');
        // If we already have data, render it immediately while we refresh
        // in the background. Otherwise show a loading hint.
        if (_pickerState.spools.length) {
            _renderPickerList();
        } else {
            _setListEmpty('Loading spools…');
        }
        _loadPickerSpools(false);
        // Focus the search box for quick typing.
        setTimeout(function () {
            Templates.$(overlay, '[data-id="search"]').focus();
        }, 50);
    }

    function _closeSpoolPicker() {
        var overlay = document.getElementById('spool-picker-modal');
        if (!overlay) return;
        overlay.style.display = 'none';
        document.body.classList.remove('tag-edit-open');
        _pickerState.target = null;
    }

    function _setPickerStatus(msg, isError) {
        var overlay = document.getElementById('spool-picker-modal');
        if (!overlay) return;
        var el = Templates.$(overlay, '[data-id="status"]');
        el.textContent = msg || '';
        el.classList.toggle('error', !!isError);
    }

    function _setListEmpty(msg) {
        var overlay = document.getElementById('spool-picker-modal');
        if (!overlay) return;
        var list = Templates.$(overlay, '[data-id="list"]');
        list.innerHTML = '';
        var empty = document.createElement('div');
        empty.className = 'spool-picker-empty';
        empty.textContent = msg;
        list.appendChild(empty);
    }

    function _loadPickerSpools(forceRefresh) {
        var overlay = document.getElementById('spool-picker-modal');
        if (!overlay) return;
        var refresh = Templates.$(overlay, '[data-id="refresh"]');
        refresh.classList.add('spinning');

        // Serve from the in-memory cache if it's fresh enough and the
        // archived flag matches. The deleted backend used a 60 s server-side
        // cache; we replicate that on the client so opening the picker stays
        // snappy without hammering Spoolman.
        var now = Date.now();
        var c = _spoolListCache;
        if (!forceRefresh && c && c.archived === _pickerState.archived
                && (now - c.ts) < _SPOOL_LIST_TTL_MS) {
            _pickerState.spools = c.items;
            _pickerState.truncated = c.truncated;
            var banner = Templates.$(overlay, '[data-id="truncated-banner"]');
            banner.hidden = !_pickerState.truncated;
            _renderPickerList();
            _setPickerStatus('', false);
            refresh.classList.remove('spinning');
            return;
        }

        var params = {};
        if (_pickerState.archived) params.allow_archived = true;

        Spoolman.listSpools(params)
            .then(function (items) {
                if (!Array.isArray(items)) items = [];
                // Cap at 1000 so an enormous library doesn't blow up the
                // picker grid; the search filter handles narrower sets.
                var truncated = false;
                if (items.length > 1000) {
                    items = items.slice(0, 1000);
                    truncated = true;
                }
                // Flatten the nested filament/vendor relations onto the
                // spool record itself so the search/sort code stays simple.
                var thinned = items.map(_thinSpool);
                _spoolListCache = {
                    ts: Date.now(),
                    items: thinned,
                    truncated: truncated,
                    archived: _pickerState.archived
                };
                _pickerState.spools = thinned;
                _pickerState.truncated = truncated;
                var banner = Templates.$(overlay, '[data-id="truncated-banner"]');
                banner.hidden = !_pickerState.truncated;
                _renderPickerList();
                _setPickerStatus('', false);
            })
            .catch(function (err) {
                _setListEmpty('Failed to load spools.');
                _setPickerStatus('Error: ' + err.message, true);
            })
            .then(function () {
                refresh.classList.remove('spinning');
            });
    }

    // Flatten Spoolman's nested record into the shape the picker UI expects.
    function _thinSpool(spool) {
        var fil = spool.filament || {};
        var ven = fil.vendor || {};
        var color = fil.color_hex || spool.color_hex || null;
        if (color && color.charAt(0) !== '#') color = '#' + color;
        var weight = (typeof spool.initial_weight === 'number') ? spool.initial_weight
                   : (typeof spool.weight === 'number') ? spool.weight
                   : (typeof fil.weight === 'number') ? fil.weight
                   : null;
        return {
            id: spool.id,
            name: spool.lot_nr || spool.name || fil.name || '',
            external_id: spool.external_id || '',
            archived: !!spool.archived,
            color_hex: color,
            weight_g: weight,
            vendor: ven.name || '',
            material: fil.material || '',
            // Keep the originals around so _useSpoolId can re-fetch the
            // expanded record without another round trip when the user
            // selects this row.
            _filament: fil,
            _vendor: ven,
            _spool: spool
        };
    }

    // Filter terms are matched as ANDed substrings against a single
    // synthesized haystack per spool. Cheap, predictable, and good enough
    // for a few thousand rows.
    function _matchesQuery(spool, terms) {
        if (!terms.length) return true;
        // _thin_spool() flattens vendor/material/name onto the spool itself
        // so we can join in one shot without nested lookups.
        var hay = [
            spool.vendor || '',
            spool.material || '',
            spool.name || '',
            spool.external_id || '',
            String(spool.id || '')
        ].join(' ').toLowerCase();
        for (var i = 0; i < terms.length; i++) {
            if (hay.indexOf(terms[i]) === -1) return false;
        }
        return true;
    }

    function _renderPickerList() {
        var overlay = document.getElementById('spool-picker-modal');
        if (!overlay) return;
        var list = Templates.$(overlay, '[data-id="list"]');
        var countEl = Templates.$(overlay, '[data-id="count"]');
        var search = Templates.$(overlay, '[data-id="search"]');
        var raw = (search.value || '').trim().toLowerCase();
        var terms = raw.length ? raw.split(/\s+/) : [];

        var filtered = [];
        for (var i = 0; i < _pickerState.spools.length; i++) {
            if (_matchesQuery(_pickerState.spools[i], terms)) {
                filtered.push(_pickerState.spools[i]);
            }
        }

        // Default sort: vendor A→Z, then material, then name.
        filtered.sort(function (a, b) {
            var av = (a.vendor || '').toLowerCase();
            var bv = (b.vendor || '').toLowerCase();
            if (av !== bv) return av < bv ? -1 : 1;
            var am = (a.material || '').toLowerCase();
            var bm = (b.material || '').toLowerCase();
            if (am !== bm) return am < bm ? -1 : 1;
            var an = (a.name || '').toLowerCase();
            var bn = (b.name || '').toLowerCase();
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });

        list.innerHTML = '';
        if (!filtered.length) {
            _setListEmpty(_pickerState.spools.length ? 'No matches.' : 'No spools.');
        } else {
            // Cap rendered rows for perf; if more match, the search box
            // narrows the field quickly enough.
            var max = Math.min(filtered.length, 500);
            for (var j = 0; j < max; j++) {
                list.appendChild(_renderPickerRow(filtered[j]));
            }
        }

        var total = _pickerState.spools.length;
        var shown = filtered.length;
        var msg = shown + ' of ' + total + ' spool' + (total === 1 ? '' : 's');
        if (_pickerState.archived) msg += ' (incl. archived)';
        countEl.textContent = msg;
    }

    function _renderPickerRow(spool) {
        var node = Templates.clone('spool-picker-row');

        var swatch = node.querySelector('[data-id="swatch"]');
        // Filament-level colour is the only standard Spoolman field; the
        // backend pre-flattens it onto the spool. Spool-level extras
        // override is applied backend-side at /tigertag-spec time.
        var c = spool.color_hex;
        if (c) {
            swatch.style.background = (c.charAt(0) === '#' ? c : '#' + c);
        }

        node.querySelector('[data-id="vendor"]').textContent = spool.vendor || '(no vendor)';
        node.querySelector('[data-id="material"]').textContent = spool.material || '';
        node.querySelector('[data-id="name"]').textContent = spool.name || '';
        node.querySelector('[data-id="id"]').textContent = '#' + spool.id;

        var w = '';
        if (typeof spool.weight_g === 'number') w = spool.weight_g + ' g';
        node.querySelector('[data-id="weight"]').textContent = w;

        var archBadge = node.querySelector('[data-id="archived-badge"]');
        archBadge.hidden = !spool.archived;

        node.addEventListener('click', function () { _useSpoolId(spool.id); });
        return node;
    }

    function _useSpoolId(spoolId) {
        var target = _pickerState.target;
        if (!target) return;
        _setPickerStatus('Loading spool #' + spoolId + '…', false);

        // Try the cached thin row first (already includes the embedded
        // filament/vendor) so we can fast-path the common picker click;
        // fall back to a full GET so by-id entries (which may not be in
        // the cache) still resolve.
        var cached = null;
        if (Array.isArray(_pickerState.spools)) {
            for (var i = 0; i < _pickerState.spools.length; i++) {
                if (_pickerState.spools[i].id === spoolId) {
                    cached = _pickerState.spools[i];
                    break;
                }
            }
        }
        var p = cached
            ? Promise.resolve(cached._spool)
            : Spoolman.getSpool(spoolId);

        p.then(function (spool) {
                var spec = TigerTag.spoolToSpec(spool, spool && spool.filament,
                    (spool && spool.filament) ? spool.filament.vendor : null);
                // Stash the spool id so the editor can later record the link
                // back into the Moonraker DB on a successful write.
                spec._source_spool_id = spoolId;
                _closeSpoolPicker();
                ensureRegistry().then(function (reg) {
                    enterEditMode(target.card, target.ch, target.config, spec, reg, true);
                }).catch(function (err) {
                    alert('Failed to load TigerTag registry: ' + err.message);
                });
            })
            .catch(function (err) {
                _setPickerStatus('Could not load spool: ' + err.message, true);
            });
    }

    // Standalone "By spool ID…" entry point used when the user already
    // knows the spool number and doesn't want to scroll the list.
    function promptByIdAndPrefill(card, ch, config) {
        var raw = window.prompt('Spoolman spool ID:');
        if (raw === null) return;
        var n = parseInt(String(raw).trim(), 10);
        if (!isFinite(n) || n <= 0) {
            alert('Please enter a positive spool ID.');
            return;
        }
        // Reuse the picker plumbing for consistent error handling and the
        // same /tigertag-spec → enterEditMode path.
        _pickerState.target = { card: card, ch: ch, config: config };
        // We skip opening the modal; _useSpoolId will close it (no-op) and
        // enter the editor directly.
        _useSpoolId(n);
    }

    function enterEditMode(card, ch, config, f, registry, isBlank) {
        _editingChannels[String(ch.channel)] = true;

        // For blank/unrecognized tags we want the editor to open mostly empty
        // (no inferred temps or dates), only pre-filling the few fields the
        // user always wants pinned: diameter 1.75 mm, weight 1000 g, unit g.

        var body = _openEditModal(
            ch.channel,
            'Write TigerTag — channel ' + (ch.channel + 1)
        );

        var content = Templates.clone('tag-edit-content');
        var grid = Templates.$(content, '[data-id="grid"]');
        body.appendChild(content);

        // Material (select). REQUIRED — the OpenRFID TigerTag parser rejects
        // unknown materials with `ValueError: Invalid filament type: Unknown(0)`,
        // which causes a successful byte-level write to still surface as a
        // parse error / unrecognized tag.
        var matInput = _selectFromRegistry(registry.materials || [], f.type || '', 'Select material…');
        if (isBlank) _prependNoneOption(matInput);
        _addRow(grid, 'Material *', matInput);

        // Brand (select)
        var brandInput = _selectFromRegistry(registry.brands || [], f.manufacturer || '', 'Select brand…');
        if (isBlank) _prependNoneOption(brandInput);
        _addRow(grid, 'Brand', brandInput);

        // Type (select). This is the TigerTag product type ("Filament" / "Resin"),
        // *not* the material modifiers. Default to Filament unless the channel
        // data carries an explicit product_type.
        var typeCurrent = (typeof f.product_type === 'string' && f.product_type) ? f.product_type : 'Filament';
        var typeInput = _selectFromRegistry(registry.types || [], typeCurrent, 'Select type…');
        _addRow(grid, 'Type', typeInput);

        // Aspect 1 / Aspect 2 (selects). The scanner exposes the on-tag aspect
        // labels through `f.modifiers` (a list like ["Marble"] or ["Silk", "Gloss"]).
        // Pre-fill from `aspect_1`/`aspect_2` first, falling back to the modifier
        // list so a freshly-scanned tag round-trips into the editor cleanly.
        var modList = Array.isArray(f.modifiers) ? f.modifiers
                    : (typeof f.modifiers === 'string' && f.modifiers) ? f.modifiers.split(/\s*,\s*/)
                    : [];
        // The TigerTag aspect database includes a "-" placeholder entry that
        // is not useful in the editor — drop it from the dropdown.
        var aspectChoices = (registry.aspects || []).filter(function (r) {
            var lab = r && (r.label || r.name);
            return lab && String(lab).trim() !== '-';
        });
        var aspect1Current = f.aspect_1 || modList[0] || 'None';
        var aspect2Current = f.aspect_2 || modList[1] || 'None';
        var aspect1 = _selectFromRegistry(aspectChoices, aspect1Current, 'Aspect 1…');
        _addRow(grid, 'Aspect 1', aspect1);
        var aspect2 = _selectFromRegistry(aspectChoices, aspect2Current, 'Aspect 2…');
        _addRow(grid, 'Aspect 2', aspect2);

        // Diameter (select). Registry labels are bare numbers ("1.75", "2.85").
        // For a blank tag we always pin 1.75 mm regardless of any 0/empty value
        // that resolveFields may have produced.
        var diaCurrent;
        if (isBlank) {
            diaCurrent = '1.75';
        } else if (f.diameter_mm !== undefined && f.diameter_mm !== null && f.diameter_mm !== '') {
            diaCurrent = String(f.diameter_mm);
        } else {
            diaCurrent = '';
        }
        var diameterInput = _selectFromRegistry(registry.diameters || [], diaCurrent, 'Diameter…');
        _addRow(grid, 'Diameter', diameterInput);

        // Color (color picker)
        var colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'channel-edit-input channel-edit-color';
        colorInput.value = _firstColorHexFromFields(f);
        _addRow(grid, 'Color', colorInput);

        // Weight (number)
        var weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.className = 'channel-edit-input channel-edit-num';
        weightInput.min = 0; weightInput.max = 16777215;
        weightInput.value = (f.weight_grams && f.weight_grams > 0) ? f.weight_grams : 1000;
        _addRow(grid, 'Weight (g)', weightInput);

        // Unit (select). Default to grams since `weight_grams` is encoded in grams.
        var unitInput = _selectFromRegistry(registry.units || [], f.unit || 'g', 'Unit…');
        _addRow(grid, 'Unit', unitInput);

        // Nozzle min / max (number, side-by-side via wrapper). Distinguish a
        // missing value (undefined/null) from a deliberate 0 — `f.x || 190`
        // would clobber a previously-written 0.
        var nozMin = document.createElement('input');
        nozMin.type = 'number'; nozMin.className = 'channel-edit-input channel-edit-num';
        nozMin.min = 0; nozMin.max = 65535;
        nozMin.value = _numericFieldDefault(f.hotend_min_temp_c, isBlank, 190);
        _addRow(grid, 'Nozzle min (°C)', nozMin);
        var nozMax = document.createElement('input');
        nozMax.type = 'number'; nozMax.className = 'channel-edit-input channel-edit-num';
        nozMax.min = 0; nozMax.max = 65535;
        nozMax.value = _numericFieldDefault(f.hotend_max_temp_c, isBlank, 220);
        _addRow(grid, 'Nozzle max (°C)', nozMax);

        // Bed min / max
        var bedMin = document.createElement('input');
        bedMin.type = 'number'; bedMin.className = 'channel-edit-input channel-edit-num';
        bedMin.min = 0; bedMin.max = 255;
        bedMin.value = _numericFieldDefault(f.bed_temp_min_c, isBlank, 50);
        _addRow(grid, 'Bed min (°C)', bedMin);
        var bedMax = document.createElement('input');
        bedMax.type = 'number'; bedMax.className = 'channel-edit-input channel-edit-num';
        bedMax.min = 0; bedMax.max = 255;
        bedMax.value = _numericFieldDefault(f.bed_temp_max_c, isBlank, 60);
        _addRow(grid, 'Bed max (°C)', bedMax);

        // Drying temp / time
        var dryTemp = document.createElement('input');
        dryTemp.type = 'number'; dryTemp.className = 'channel-edit-input channel-edit-num';
        dryTemp.min = 0; dryTemp.max = 255;
        dryTemp.value = f.drying_temp_c || 0;
        _addRow(grid, 'Dry temp (°C)', dryTemp);
        var dryTime = document.createElement('input');
        dryTime.type = 'number'; dryTime.className = 'channel-edit-input channel-edit-num';
        dryTime.min = 0; dryTime.max = 255;
        dryTime.value = f.drying_time_hours || 0;
        _addRow(grid, 'Dry time (h)', dryTime);

        // Manufacturing date — the on-tag value is seconds since 2000-01-01 and
        // the encoder accepts an ISO `YYYY-MM-DD`. Default to today when the
        // existing tag has none so a fresh write stamps a sensible date.
        var mfgInput = document.createElement('input');
        mfgInput.type = 'date';
        mfgInput.className = 'channel-edit-input channel-edit-date';
        var mfgIso = '';
        if (typeof f.manufacturing_date === 'string' && f.manufacturing_date) {
            // Accept either `YYYY-MM-DD` or anything Date can parse; reduce to date.
            var m = /^(\d{4}-\d{2}-\d{2})/.exec(f.manufacturing_date);
            if (m) {
                mfgIso = m[1];
            } else {
                var d = new Date(f.manufacturing_date);
                if (!isNaN(d.getTime())) mfgIso = d.toISOString().slice(0, 10);
            }
        }
        if (!mfgIso) mfgIso = new Date().toISOString().slice(0, 10);
        mfgInput.value = mfgIso;
        _addRow(grid, 'Manufacturing date', mfgInput);

        // TD (Transmission Distance) in mm. The on-tag value is a uint16 in
        // tenths of a millimetre (range 0..6553.5 mm); the backend encoder takes
        // millimetres and does the * 10 conversion.
        var tdInput = document.createElement('input');
        tdInput.type = 'number'; tdInput.className = 'channel-edit-input channel-edit-num';
        tdInput.min = 0; tdInput.max = 6553.5; tdInput.step = 0.1;
        tdInput.value = (f.td !== undefined && f.td !== null) ? f.td : 0;
        _addRow(grid, 'TD (mm)', tdInput);

        // Message. Upstream OpenRFID exposes the full 32-byte metadata region
        // as a single UTF-8 string — there is no separate emoji slot.
        var msgInput = document.createElement('input');
        msgInput.type = 'text';
        msgInput.className = 'channel-edit-input channel-edit-message';
        msgInput.maxLength = 28;
        msgInput.placeholder = 'i.e. name, max 28 characters';
        msgInput.value = (typeof f.message === 'string') ? f.message : '';
        _addRow(grid, 'Message', msgInput);

        // Action row (template provides cancel/write/status)
        var cancelBtn = Templates.$(content, '[data-id="cancel"]');
        var writeBtn = Templates.$(content, '[data-id="write"]');
        var clearBtn = Templates.$(content, '[data-id="clear"]');
        var status = Templates.$(content, '[data-id="status"]');

        // Clear-tag button: only meaningful when something is already on the
        // tag. Hidden for blank/unrecognized tags.
        if (clearBtn && !isBlank) {
            clearBtn.hidden = false;
            clearBtn.addEventListener('click', function () {
                if (!confirm('Erase all data on this tag? This will write 96 zero bytes to the NTAG215 user pages and cannot be undone.')) {
                    return;
                }
                clearTag(ch.channel, clearBtn, writeBtn, cancelBtn, status);
            });
        }

        cancelBtn.addEventListener('click', function () {
            exitEditMode(ch);
        });

        writeBtn.addEventListener('click', function () {
            // Validate required fields. Material is the only field the parser
            // strictly requires — see comment on the Material row above.
            if (!matInput.value) {
                status.textContent = '✗ Material is required (the tag would write but stay unrecognized)';
                status.className = 'channel-edit-status channel-edit-err';
                matInput.focus();
                return;
            }
            var spec = {
                material:        matInput.value || '',
                brand:           brandInput.value || '',
                type:            typeInput.value || '',
                aspect_1:        aspect1.value || '',
                aspect_2:        aspect2.value || '',
                diameter:        diameterInput.value || '',
                color:           colorInput.value || '#000000',
                weight_g:        parseInt(weightInput.value, 10) || 0,
                unit:            unitInput.value || '',
                temp_min_c:      parseInt(nozMin.value, 10) || 0,
                temp_max_c:      parseInt(nozMax.value, 10) || 0,
                bed_temp_min_c:  parseInt(bedMin.value, 10) || 0,
                bed_temp_max_c:  parseInt(bedMax.value, 10) || 0,
                dry_temp_c:      parseInt(dryTemp.value, 10) || 0,
                dry_time_h:      parseInt(dryTime.value, 10) || 0,
                td_mm:           parseFloat(tdInput.value) || 0,
                manufacturing_date: mfgInput.value || '',
                message:         msgInput.value || ''
            };
            writeTag(ch.channel, spec, writeBtn, cancelBtn, status);
        });
    }

    function exitEditMode(ch) {
        // Channel state cleanup happens inside _closeEditModal so that closing
        // via overlay/Esc/X also resets state.
        _closeEditModal();
    }

    function writeTag(channel, spec, writeBtn, cancelBtn, statusEl) {
        writeBtn.disabled = true;
        cancelBtn.disabled = true;
        var origText = writeBtn.textContent;
        writeBtn.textContent = 'Writing…';
        statusEl.textContent = '';
        statusEl.className = 'channel-edit-status';

        function reset() {
            writeBtn.disabled = false;
            cancelBtn.disabled = false;
            writeBtn.textContent = origText;
        }

        // Two-step write: ask the agent to encode the spec into the 96-byte
        // TigerTag payload, then push the resulting hex to the chosen slot.
        // The encoder runs upstream because it's the source of truth for the
        // wire format; the SPA never touches struct packing.
        var openrfid = App.openrfid();
        openrfid.tigertagEncode(spec)
            .then(function (encoded) {
                if (!encoded || encoded.ok === false) {
                    var msg = (encoded && (encoded.error || encoded.message)) || 'encode failed';
                    throw new Error(msg);
                }
                var hex = encoded.data_hex || encoded.hex || encoded.data;
                if (!hex) throw new Error('encoder returned no data_hex');
                return openrfid.writeTag(channel, hex);
            })
            .then(function (res) {
                reset();
                var ok = res && (res.ok === true || res.state === 'success');
                if (ok) {
                    statusEl.textContent = '✓ Written';
                    statusEl.className = 'channel-edit-status channel-edit-ok';
                    // Tag bytes just changed on disk — ask the agent to
                    // re-read the slot so the cached `tag.filament` block
                    // updates. Drop the spoolman cache + UID index for
                    // this channel so the next render refreshes the
                    // suggestion list and badge against the new tag
                    // contents. The scan event re-fires fetchChannels
                    // via onScan; we also schedule a manual fetch as a
                    // belt-and-suspenders fallback in case the event is
                    // dropped.
                    delete _spoolmanCache[channel];
                    _uidSyncIndexTs = 0;
                    var openrfidRefresh = App.openrfid();
                    openrfidRefresh.scanSlot(channel)
                        .catch(function (err) {
                            console.warn('post-write rescan failed:', err && err.message);
                        });
                    setTimeout(function () { fetchChannels(); }, 250);
                    setTimeout(function () { _closeEditModal(); }, 800);
                } else {
                    var emsg = (res && (res.error || res.message)) || 'write failed';
                    statusEl.textContent = '✗ ' + emsg;
                    statusEl.className = 'channel-edit-status channel-edit-err';
                }
            })
            .catch(function (err) {
                reset();
                statusEl.textContent = '✗ ' + err.message;
                statusEl.className = 'channel-edit-status channel-edit-err';
            });
    }

    // Erase the user-data area of an NTAG215 by asking the OpenRFID agent
    // to write 24 zero pages (96 bytes) starting at the user-data page.
    function clearTag(channel, clearBtn, writeBtn, cancelBtn, statusEl) {
        clearBtn.disabled = true;
        writeBtn.disabled = true;
        cancelBtn.disabled = true;
        var origText = clearBtn.textContent;
        clearBtn.textContent = 'Clearing\u2026';
        statusEl.textContent = '';
        statusEl.className = 'channel-edit-status';

        function reset() {
            clearBtn.disabled = false;
            writeBtn.disabled = false;
            cancelBtn.disabled = false;
            clearBtn.textContent = origText;
        }

        App.openrfid().clearTag(channel)
            .then(function (res) {
                reset();
                var ok = res && (res.ok === true || res.state === 'success');
                if (ok) {
                    statusEl.textContent = '\u2713 Cleared';
                    statusEl.className = 'channel-edit-status channel-edit-ok';
                    delete _spoolmanCache[channel];
                    _uidSyncIndexTs = 0;
                    App.openrfid().scanSlot(channel)
                        .catch(function (err) {
                            console.warn('post-clear rescan failed:', err && err.message);
                        });
                    setTimeout(function () { fetchChannels(); }, 250);
                    setTimeout(function () { _closeEditModal(); }, 800);
                } else {
                    var emsg = (res && (res.error || res.message)) || 'clear failed';
                    statusEl.textContent = '\u2717 ' + emsg;
                    statusEl.className = 'channel-edit-status channel-edit-err';
                }
            })
            .catch(function (err) {
                reset();
                statusEl.textContent = '\u2717 ' + err.message;
                statusEl.className = 'channel-edit-status channel-edit-err';
            });
    }

    function syncToSpoolman(channel, nameInput, densityInput, statusEl, btn, filamentId) {
        var originalBtnText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Syncing\u2026';
        statusEl.textContent = '';
        statusEl.className = 'spoolman-sync-status';

        var density = parseFloat(densityInput.value);
        if (isNaN(density)) density = 1.24;

        // Look up the channel so we can grab the on-tag UID + cached fields
        // and pass real numbers to Spoolman.
        var ch = null;
        for (var i = 0; i < _channels.length; i++) {
            if (_channels[i].channel === channel) { ch = _channels[i]; break; }
        }
        if (!ch) {
            btn.disabled = false;
            btn.textContent = originalBtnText;
            statusEl.textContent = 'No channel data';
            statusEl.className = 'spoolman-sync-status spoolman-sync-err';
            return;
        }

        var f = resolveFields(ch, App.getConfig());
        var uid = (ch.tag && ch.tag.scan && ch.tag.scan.uid) || (ch.moonraker && ch.moonraker.CARD_UID);
        var uidStr = Array.isArray(uid) ? formatUid(uid) : (uid ? String(uid) : null);
        if (!uidStr) {
            btn.disabled = false;
            btn.textContent = originalBtnText;
            statusEl.textContent = 'Tag has no UID \u2014 cannot link to Spoolman';
            statusEl.className = 'spoolman-sync-status spoolman-sync-err';
            return;
        }

        var prevLink = (App.getConfig().slot_spool_links || {})[uidStr];

        // Compute the canonical RGB color hex (no leading #) for both the
        // filament's first-class column and the on-tag derived display.
        var color = (function () {
            var src = f.colors;
            if (Array.isArray(src) && src.length > 0 && typeof src[0] === 'number') {
                var argb = src[0];
                var r = (argb >> 16) & 0xFF, g = (argb >> 8) & 0xFF, b = argb & 0xFF;
                return ('00' + r.toString(16)).slice(-2)
                     + ('00' + g.toString(16)).slice(-2)
                     + ('00' + b.toString(16)).slice(-2);
            }
            if (typeof src === 'string') return src.replace(/^#/, '');
            return null;
        })();

        // Multi-tag-per-spool support: a single physical spool can carry
        // up to two NTAG215 stickers. The canonical "tags belonging to
        // this spool" lives on Spoolman (`spool.extra.rfid_uid` as a
        // comma-separated string — Spoolman's `text` extra type only
        // accepts JSON-encoded strings, not arrays). slot_spool_links
        // is the local source of truth: every UID pointing at the same
        // spool id belongs to the same set. Recompute on every write
        // so a newly-linked second tag automatically appears in
        // Spoolman too.
        function computeUidString(spoolId) {
            var links = App.getConfig().slot_spool_links || {};
            var seen = {};
            var arr = [];
            if (spoolId) {
                Object.keys(links).forEach(function (u) {
                    if (links[u] === spoolId && !seen[u]) {
                        seen[u] = true;
                        arr.push(u);
                    }
                });
            }
            if (!seen[uidStr]) arr.push(uidStr);
            return arr.join(',');
        }

        // Spoolman 422s any POST/PATCH that touches an extra-field key it
        // doesn't know about. `rfid_uid` is mandatory for our UID-based
        // linking, so transparently make sure it's registered before the
        // first upsert. Idempotent: list first, only create what's
        // missing — mirrors the explicit "Register fields" button on the
        // Spoolman config page. `color_hex` is a first-class filament
        // column so we don't register it as a spool extra.
        var ensureCoreSpoolExtras = Spoolman.listExtraFields('spool')
            .then(function (existing) {
                var have = {};
                if (Array.isArray(existing)) {
                    for (var k = 0; k < existing.length; k++) {
                        if (existing[k] && existing[k].key) have[existing[k].key] = true;
                    }
                }
                if (have.rfid_uid) return;
                return Spoolman.createExtraField('spool', 'rfid_uid',
                    { name: 'RFID Tag UID', field_type: 'text' }
                ).catch(function () {});
            })
            .catch(function () { /* best-effort; the upsert below will surface real errors */ });

        // Locate (or create) a filament we can attach the spool to. Three
        // cases: explicit filamentId from the picker, existing link
        // (look up via prevLink so we PATCH the same filament), and
        // no prior state (full vendor → filament create chain).
        function resolveFilament() {
            if (filamentId) return Promise.resolve(filamentId);
            if (prevLink) {
                return Spoolman.getSpool(prevLink).then(function (spool) {
                    if (spool && spool.filament && spool.filament.id) {
                        return spool.filament.id;
                    }
                    // Existing spool with no filament shouldn't happen,
                    // but fall through to the create chain rather than
                    // hard-failing the sync.
                    return createVendorAndFilament();
                });
            }
            return createVendorAndFilament();
        }

        // Build the Spoolman filament payload from the current tag
        // fields + form inputs. Used both when creating a brand-new
        // filament and when PATCHing an existing one on resync, so the
        // "Sync ↗" button actually pushes the latest tag data instead of
        // just touching the spool.
        function buildFilamentPayload() {
            var vendorName = (f.manufacturer && String(f.manufacturer).trim())
                              || 'Generic';
            var filName = (nameInput.value && nameInput.value.trim())
                || (vendorName + ' '
                    + (f.type || 'Filament')
                    + (Array.isArray(f.modifiers) && f.modifiers.length
                        ? ' ' + f.modifiers.join(' ')
                        : ''));
            var payload = {
                name: filName,
                density: density,
                diameter: f.diameter_mm || 1.75
            };
            if (f.type) payload.material = f.type;
            if (color) payload.color_hex = color;
            if (f.weight_grams && f.weight_grams > 0) payload.weight = f.weight_grams;
            if (typeof f.hotend_max_temp_c === 'number') {
                payload.settings_extruder_temp = f.hotend_max_temp_c;
            }
            if (typeof f.bed_temp_c === 'number') {
                payload.settings_bed_temp = f.bed_temp_c;
            }

            // Populate the seven registered filament extras from tag
            // data so the filament stays useful. Spoolman stores extras
            // as JSON-encoded values (the same `JSON.stringify`
            // convention Mainsail and Fluidd use), so ints/floats/
            // strings all round-trip.
            var extra = {};
            function setExtra(key, val) {
                if (val === undefined || val === null || val === '') return;
                extra[key] = JSON.stringify(val);
            }
            setExtra('max_extruder_temp', f.hotend_max_temp_c);
            setExtra('max_bed_temp',      f.bed_temp_max_c);
            setExtra('drying_temp',       f.drying_temp_c);
            setExtra('drying_time',       f.drying_time_hours);
            setExtra('td',                f.td);
            setExtra('mfg_date',          f.manufacturing_date);
            if (Array.isArray(f.modifiers) && f.modifiers.length) {
                setExtra('modifiers', f.modifiers.join(', '));
            } else if (typeof f.modifiers === 'string' && f.modifiers) {
                setExtra('modifiers', f.modifiers);
            }
            if (Object.keys(extra).length) payload.extra = extra;
            return payload;
        }

        function resolveVendorId() {
            var vendorName = (f.manufacturer && String(f.manufacturer).trim())
                              || 'Generic';
            return Spoolman.listVendors()
                .then(function (vendors) {
                    if (Array.isArray(vendors)) {
                        var lower = vendorName.toLowerCase();
                        for (var v = 0; v < vendors.length; v++) {
                            if (vendors[v] && vendors[v].name
                                && String(vendors[v].name).toLowerCase() === lower) {
                                return vendors[v].id;
                            }
                        }
                    }
                    return Spoolman.createVendor({ name: vendorName })
                        .then(function (vend) { return vend.id; });
                });
        }

        function createVendorAndFilament() {
            return resolveVendorId().then(function (vendorId) {
                var basePayload = buildFilamentPayload();
                var filName = basePayload.name;
                // Avoid duplicate filaments on retry: look for an
                // existing filament with the same vendor + name and
                // reuse it. Spoolman doesn't enforce uniqueness, so
                // this is the SPA's responsibility.
                return Spoolman.listFilaments({ vendor_id: vendorId })
                    .catch(function () { return []; })
                    .then(function (existing) {
                        if (Array.isArray(existing)) {
                            var lower = filName.toLowerCase();
                            for (var i = 0; i < existing.length; i++) {
                                if (existing[i] && existing[i].name
                                    && String(existing[i].name).toLowerCase() === lower) {
                                    return existing[i].id;
                                }
                            }
                        }
                        return null;
                    })
                    .then(function (foundId) {
                        if (foundId) return foundId;
                        var createPayload = Object.assign({ vendor_id: vendorId }, basePayload);
                        return Spoolman.createFilament(createPayload)
                            .then(function (fil) { return fil.id; });
                    });
            });
        }

        var op = ensureCoreSpoolExtras
            .then(resolveFilament)
            .then(function (resolvedFilamentId) {
                // On resync of an existing link, push the latest tag
                // fields (Name input, density, color, weight, temps,
                // extras) onto the filament so the Sync button actually
                // syncs — not just touches the spool. We don't reassign
                // the vendor here: that would be too surprising if the
                // user manually moved the filament under a different
                // vendor in Spoolman. New imports go through
                // createVendorAndFilament which already sets the vendor.
                if (prevLink) {
                    var filPayload = buildFilamentPayload();
                    return Spoolman.updateFilament(resolvedFilamentId, filPayload)
                        .catch(function (err) {
                            console.warn('filament PATCH failed on resync:', err && err.message);
                        })
                        .then(function () { return resolvedFilamentId; });
                }
                return resolvedFilamentId;
            })
            .then(function (resolvedFilamentId) {
                // Build the spool payload now that we have a filament_id
                // committed. The Name field in the form drives the
                // *filament* name (see buildFilamentPayload).
                //
                // For `rfid_uid` we union three sources to keep multi-tag
                // spools robust across machines:
                //   1. The remote `extra.rfid_uid` already on the spool
                //      (so a UID written from another printer/tab isn't
                //      silently dropped).
                //   2. Our local `slot_spool_links` (every UID pointing
                //      at this spool id).
                //   3. The UID we're syncing right now.
                function buildSpoolPayload(remoteUidStr) {
                    var seen = {};
                    var arr = [];
                    function addAll(list) {
                        if (!Array.isArray(list)) return;
                        list.forEach(function (u) {
                            if (!u) return;
                            var k = String(u).toUpperCase();
                            if (seen[k]) return;
                            seen[k] = true;
                            arr.push(String(u));
                        });
                    }
                    addAll(parseRfidUidExtra(remoteUidStr));
                    var localCsv = computeUidString(prevLink);
                    addAll(localCsv ? localCsv.split(',') : []);
                    addAll([uidStr]);
                    return {
                        filament_id: resolvedFilamentId,
                        initial_weight: (f.weight_grams && f.weight_grams > 0) ? f.weight_grams : 1000,
                        extra: { rfid_uid: JSON.stringify(arr.join(',')) }
                    };
                }

                if (prevLink) {
                    // Re-fetch the spool to merge with whatever extras
                    // already exist remotely. Falls back to the local
                    // union if the GET fails.
                    return Spoolman.getSpool(prevLink)
                        .catch(function () { return null; })
                        .then(function (sp) {
                            var remote = (sp && sp.extra && sp.extra.rfid_uid) || null;
                            return Spoolman.updateSpool(prevLink, buildSpoolPayload(remote));
                        });
                }
                return Spoolman.upsertSpool(buildSpoolPayload(null));
            });

        op.then(function (spool) {
                // Persist the UID → spool-id link so the next sync patches
                // instead of creating a new record.
                var links = Object.assign({}, App.getConfig().slot_spool_links || {});
                links[uidStr] = spool.id;
                return App.saveConfig({ slot_spool_links: links }).then(function () {
                    return spool;
                });
            })
            .then(function (spool) {
                // Tell Klipper a filament change happened so it can refresh
                // its [filament_detect] info — same gcode the deleted backend
                // used. Failures here are non-fatal (the macro may not exist
                // on every install).
                return App.moonraker().call('printer.gcode.script', {
                    script: 'FILAMENT_DT_UPDATE CHANNEL=' + channel
                }).catch(function (err) {
                    console.warn('FILAMENT_DT_UPDATE failed:', err && err.message);
                }).then(function () { return spool; });
            })
            .then(function (spool) {
                btn.disabled = false;
                btn.textContent = originalBtnText;
                statusEl.textContent = prevLink ? 'Updated \u2713' : 'Created \u2713';
                statusEl.className = 'spoolman-sync-status spoolman-sync-ok';
                delete _spoolmanCache[channel];
                // Force the UID matcher to repull so the new/updated spool
                // shows the synced badge immediately instead of after the
                // 30s TTL.
                refreshUidSyncIndex(true).then(function () { fetchChannels(); });
                return spool;
            })
            .catch(function (err) {
                btn.disabled = false;
                btn.textContent = originalBtnText;
                var msg = (err && err.message) || 'sync failed';
                if (err && err.status === 422) {
                    msg = 'Spoolman rejected the data \u2014 check Config \u2192 Spoolman that filament extras are registered';
                }
                statusEl.textContent = msg;
                statusEl.className = 'spoolman-sync-status spoolman-sync-err';
            });
    }

    // Parse a Spoolman `extra.rfid_uid` value into an array of UID strings.
    // Spoolman's `text` field type stores values as JSON-encoded strings, so
    // the raw value looks like `"\"AABBCC,112233\""`. Tolerates three forms:
    //   1. JSON-encoded CSV string  → "AABBCC,112233"   (current write format)
    //   2. JSON-encoded single UID  → "AABBCC"          (legacy, pre-multi-tag)
    //   3. JSON-encoded array       → ["AABBCC","..."]   (legacy, never written but Spoolman accepts)
    function parseRfidUidExtra(raw) {
        if (raw === undefined || raw === null) return [];
        var val = raw;
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (e) { /* treat as plain string */ }
        }
        var out = [];
        if (Array.isArray(val)) {
            for (var i = 0; i < val.length; i++) {
                if (val[i]) out.push(String(val[i]).trim());
            }
        } else if (typeof val === 'string') {
            var parts = val.split(',');
            for (var j = 0; j < parts.length; j++) {
                var p = parts[j].trim();
                if (p) out.push(p);
            }
        } else if (typeof val === 'number') {
            out.push(String(val));
        }
        return out;
    }

    // Pull the full Spool list from Spoolman and rebuild the UID→spool index.
    // This is the "matcher" that lets the SPA recognise spools whose tags
    // were registered on Spoolman directly (or via a different printer)
    // without ever having been imported through this UI. As a side effect
    // it back-fills `slot_spool_links` so subsequent syncs PATCH instead of
    // creating duplicate spools. Deduped via _uidSyncRefreshing.
    function refreshUidSyncIndex(force) {
        if (_uidSyncRefreshing) return _uidSyncRefreshing;
        if (!force && (Date.now() - _uidSyncIndexTs) < _UID_INDEX_TTL_MS) {
            return Promise.resolve(_uidSyncIndex);
        }
        _uidSyncRefreshing = Spoolman.listSpools()
            .then(function (spools) {
                _spoolmanSpoolsCache = Array.isArray(spools) ? spools : [];
                var idx = {};
                if (Array.isArray(spools)) {
                    for (var i = 0; i < spools.length; i++) {
                        var sp = spools[i];
                        if (!sp || !sp.extra) continue;
                        var uids = parseRfidUidExtra(sp.extra.rfid_uid);
                        if (!uids.length) continue;
                        var fil = sp.filament || {};
                        var entry = {
                            spool_id: sp.id,
                            filament_id: fil.id || null,
                            name: fil.name || ('Spool #' + sp.id),
                            density: (typeof fil.density === 'number') ? fil.density : null
                        };
                        for (var u = 0; u < uids.length; u++) {
                            idx[uids[u].toUpperCase()] = entry;
                        }
                    }
                }
                _uidSyncIndex = idx;
                _uidSyncIndexTs = Date.now();

                // Back-fill slot_spool_links for any UID Spoolman knows
                // about but we don't. Single saveConfig at the end so we
                // don't thrash the namespace API.
                var localLinks = App.getConfig().slot_spool_links || {};
                var merged = Object.assign({}, localLinks);
                var changed = false;
                Object.keys(idx).forEach(function (uidUpper) {
                    var spoolId = idx[uidUpper].spool_id;
                    if (merged[uidUpper] !== spoolId) {
                        merged[uidUpper] = spoolId;
                        changed = true;
                    }
                });
                if (changed) {
                    return App.saveConfig({ slot_spool_links: merged })
                        .catch(function (err) { console.warn('back-fill slot_spool_links failed:', err && err.message); })
                        .then(function () { return _uidSyncIndex; });
                }
                return _uidSyncIndex;
            })
            .catch(function (err) {
                console.warn('refreshUidSyncIndex failed:', err && err.message);
                // Don't clobber a stale-but-usable index on transient errors.
                return _uidSyncIndex;
            })
            .then(function (idx) {
                _uidSyncRefreshing = null;
                return idx;
            });
        return _uidSyncRefreshing;
    }

    // Score Spoolman spools against the tag fields parsed off a channel
    // and return the top candidates. Used to suggest "you probably want to
    // link this slot to one of these existing spools" so the user doesn't
    // create duplicates when they re-flash a printer or scan a known
    // filament for the first time. Scoring is deliberately loose: any
    // single signal (vendor, material, exact name, color within RGB
    // distance) buys the spool a row, multiple signals push it up.
    //
    //   f             : resolveFields() output for the channel
    //   excludeUids   : array of UIDs already linked to *this* channel
    //                   (so we don't suggest the spool we already match)
    //
    // Returns up to 5 entries: { spool, score, reasons:[string] }.
    function findSpoolMatches(f, excludeUids) {
        if (!f || !_spoolmanSpoolsCache.length) return [];

        function colorDistance(hexA, hexB) {
            // Cheap RGB distance; lower = closer. ~30 looks "the same"
            // on a 0-441 scale (worst case sqrt(3*255^2)).
            if (!hexA || !hexB) return Infinity;
            var a = hexA.replace(/^#/, '').toLowerCase();
            var b = hexB.replace(/^#/, '').toLowerCase();
            if (a.length !== 6 || b.length !== 6) return Infinity;
            var ar = parseInt(a.slice(0, 2), 16), ag = parseInt(a.slice(2, 4), 16), ab = parseInt(a.slice(4, 6), 16);
            var br = parseInt(b.slice(0, 2), 16), bg = parseInt(b.slice(2, 4), 16), bb = parseInt(b.slice(4, 6), 16);
            var dr = ar - br, dg = ag - bg, db = ab - bb;
            return Math.sqrt(dr * dr + dg * dg + db * db);
        }

        // Tag-side color → hex (no leading #), reusing the same logic
        // syncToSpoolman uses for filament.color_hex.
        var tagColor = (function () {
            var src = f.colors;
            if (Array.isArray(src) && src.length > 0 && typeof src[0] === 'number') {
                var argb = src[0];
                var r = (argb >> 16) & 0xFF, g = (argb >> 8) & 0xFF, b = argb & 0xFF;
                return ('00' + r.toString(16)).slice(-2)
                     + ('00' + g.toString(16)).slice(-2)
                     + ('00' + b.toString(16)).slice(-2);
            }
            if (typeof src === 'string') return src.replace(/^#/, '');
            return null;
        })();

        var tagVendor   = (f.manufacturer || '').toString().trim().toLowerCase();
        var tagMaterial = (f.type || '').toString().trim().toLowerCase();
        var tagName     = (f.message || '').toString().trim().toLowerCase();
        var tagModifiers = Array.isArray(f.modifiers) ? f.modifiers.map(function (m) {
            return String(m).toLowerCase();
        }) : [];

        var excludeUidSet = {};
        (excludeUids || []).forEach(function (u) { excludeUidSet[String(u).toUpperCase()] = true; });

        var out = [];
        for (var i = 0; i < _spoolmanSpoolsCache.length; i++) {
            var sp = _spoolmanSpoolsCache[i];
            if (!sp) continue;
            var fil = sp.filament || {};
            var vendor = (fil.vendor && fil.vendor.name) || '';
            var material = fil.material || '';
            var name = fil.name || '';
            var colorHex = fil.color_hex || '';

            // Drop spools already linked to this channel (the badge handles those).
            if (sp.extra && sp.extra.rfid_uid) {
                var existing = parseRfidUidExtra(sp.extra.rfid_uid);
                var alreadyLinkedHere = false;
                for (var u = 0; u < existing.length; u++) {
                    if (excludeUidSet[existing[u].toUpperCase()]) {
                        alreadyLinkedHere = true; break;
                    }
                }
                if (alreadyLinkedHere) continue;
            }

            var score = 0;
            var reasons = [];

            if (tagVendor && vendor && vendor.toLowerCase() === tagVendor) {
                score += 3; reasons.push('vendor');
            }
            if (tagMaterial && material && material.toLowerCase() === tagMaterial) {
                score += 2; reasons.push('material');
            }
            if (tagColor && colorHex) {
                var dist = colorDistance(tagColor, colorHex);
                if (dist <= 8)        { score += 3; reasons.push('color\u00a0\u2713'); }
                else if (dist <= 30)  { score += 2; reasons.push('color\u2248'); }
                else if (dist <= 60)  { score += 1; reasons.push('color~'); }
            }
            if (tagName && name) {
                var nLower = name.toLowerCase();
                if (nLower === tagName) { score += 3; reasons.push('name\u00a0\u2713'); }
                else if (nLower.indexOf(tagName) !== -1 || tagName.indexOf(nLower) !== -1) {
                    score += 1; reasons.push('name~');
                }
            }
            if (tagModifiers.length && fil.extra && fil.extra.modifiers) {
                var spMods = String(fil.extra.modifiers).toLowerCase();
                for (var m = 0; m < tagModifiers.length; m++) {
                    if (spMods.indexOf(tagModifiers[m]) !== -1) { score += 1; reasons.push('modifier'); break; }
                }
            }

            if (score >= 2) out.push({ spool: sp, score: score, reasons: reasons });
        }

        out.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return (a.spool.id || 0) - (b.spool.id || 0);
        });
        return out.slice(0, 5);
    }

    // Link an existing Spoolman spool to a channel UID:
    //   1. PATCH the spool's extra.rfid_uid to add this UID (multi-tag aware).
    //   2. saveConfig({slot_spool_links}) so the local map points at it.
    //   3. Force-refresh the UID index + repaint so the badge appears.
    function linkExistingSpool(channel, spool, statusEl, btn) {
        var ch = null;
        for (var i = 0; i < _channels.length; i++) {
            if (_channels[i].channel === channel) { ch = _channels[i]; break; }
        }
        if (!ch) return;
        var uid = (ch.tag && ch.tag.scan && ch.tag.scan.uid) || (ch.moonraker && ch.moonraker.CARD_UID);
        var uidStr = Array.isArray(uid) ? formatUid(uid) : (uid ? String(uid) : null);
        if (!uidStr) return;

        var originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Linking\u2026';
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = 'spoolman-sync-status';
        }

        // Build the new UID list: existing extras + this UID, deduped.
        var existing = (spool.extra && spool.extra.rfid_uid) ? parseRfidUidExtra(spool.extra.rfid_uid) : [];
        var seen = {};
        var uidArr = [];
        existing.forEach(function (u) {
            var k = u.toUpperCase();
            if (!seen[k]) { seen[k] = true; uidArr.push(u); }
        });
        if (!seen[uidStr.toUpperCase()]) uidArr.push(uidStr);

        Spoolman.updateSpool(spool.id, { extra: { rfid_uid: JSON.stringify(uidArr.join(',')) } })
            .then(function () {
                var links = Object.assign({}, App.getConfig().slot_spool_links || {});
                links[uidStr] = spool.id;
                return App.saveConfig({ slot_spool_links: links });
            })
            .then(function () {
                btn.textContent = 'Linked \u2713';
                if (statusEl) {
                    statusEl.textContent = 'Linked to spool #' + spool.id;
                    statusEl.className = 'spoolman-sync-status spoolman-sync-ok';
                }
                delete _spoolmanCache[channel];
                refreshUidSyncIndex(true).then(function () { fetchChannels(); });
            })
            .catch(function (err) {
                btn.disabled = false;
                btn.textContent = originalText;
                if (statusEl) {
                    statusEl.textContent = (err && err.message) || 'link failed';
                    statusEl.className = 'spoolman-sync-status spoolman-sync-err';
                }
            });
    }

    // Detach a channel from its current Spoolman spool: PATCH the spool's
    // extra.rfid_uid to drop this channel's UID, drop the local
    // slot_spool_links entry, and force-refresh so the badge clears and
    // the create form / suggestions reappear. The spool itself stays in
    // Spoolman; only the link is removed.
    function unlinkChannel(channel, spoolId, btn) {
        var ch = null;
        for (var i = 0; i < _channels.length; i++) {
            if (_channels[i].channel === channel) { ch = _channels[i]; break; }
        }
        if (!ch) return;
        var uid = (ch.tag && ch.tag.scan && ch.tag.scan.uid) || (ch.moonraker && ch.moonraker.CARD_UID);
        var uidStr = Array.isArray(uid) ? formatUid(uid) : (uid ? String(uid) : null);
        if (!uidStr) return;

        var originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Unlinking\u2026';

        // Pull the spool fresh so we PATCH against the current value of
        // extra.rfid_uid (other clients / the user may have edited it).
        Spoolman.getSpool(spoolId)
            .catch(function () { return null; })
            .then(function (spool) {
                var existing = (spool && spool.extra && spool.extra.rfid_uid)
                    ? parseRfidUidExtra(spool.extra.rfid_uid)
                    : [];
                var uidUpper = uidStr.toUpperCase();
                var remaining = existing.filter(function (u) {
                    return String(u).toUpperCase() !== uidUpper;
                });
                // CSV form (matches the write path); empty string when no
                // UIDs left so Spoolman keeps the field but clears it.
                var patchBody = { extra: { rfid_uid: JSON.stringify(remaining.join(',')) } };
                if (!spool) {
                    // Spool already gone in Spoolman — skip the PATCH and
                    // just clean up locally.
                    return null;
                }
                return Spoolman.updateSpool(spoolId, patchBody);
            })
            .catch(function (err) {
                // 404 or transient: still clean up the local link so the
                // user isn't stuck staring at a broken badge.
                console.warn('unlink PATCH failed:', err && err.message);
            })
            .then(function () {
                var links = Object.assign({}, App.getConfig().slot_spool_links || {});
                delete links[uidStr];
                return App.saveConfig({ slot_spool_links: links });
            })
            .then(function () {
                delete _spoolmanCache[channel];
                _uidSyncIndexTs = 0;
                refreshUidSyncIndex(true).then(function () { fetchChannels(); });
            })
            .catch(function (err) {
                btn.disabled = false;
                btn.textContent = originalText;
                console.warn('unlink failed:', err && err.message);
            });
    }

    // Annotate channels in-place with spoolman_sync info from the UID index.
    // Mirrored into _spoolmanCache so the existing render path picks it up
    // on first paint without an extra getSpool() round-trip per channel.
    function applyUidSyncIndex(channels) {
        for (var i = 0; i < channels.length; i++) {
            var ch = channels[i];
            var uid = (ch.tag && ch.tag.scan && ch.tag.scan.uid) || (ch.moonraker && ch.moonraker.CARD_UID);
            var uidStr = Array.isArray(uid) ? formatUid(uid) : (uid ? String(uid) : null);
            if (!uidStr) continue;
            var entry = _uidSyncIndex[uidStr.toUpperCase()];
            if (!entry) continue;
            ch.spoolman_sync = { spool_id: entry.spool_id, filament_id: entry.filament_id };
            _spoolmanCache[ch.channel] = {
                spool_id: entry.spool_id,
                filament_id: entry.filament_id,
                name: entry.name,
                density: entry.density
            };
        }
    }

    function refreshSpoolmanCache(channels) {
        // First refresh the UID→spool index (cheap when fresh); on completion,
        // re-render via fetchChannels so the badge appears. The legacy
        // per-channel getSpool path below is only used as a fallback when a
        // UID is in slot_spool_links but the matching spool isn't in the
        // index yet (e.g. just-created spool, index TTL not yet expired).
        var spoolmanUrl = (App.getConfig() || {}).spoolman_url;
        if (!spoolmanUrl) return;

        var indexWasStale = (Date.now() - _uidSyncIndexTs) >= _UID_INDEX_TTL_MS;
        refreshUidSyncIndex(false).then(function () {
            if (indexWasStale) fetchChannels();
        });

        if (_spoolmanFetchPending) return;
        // Build the list of (channel, spool_id) pairs we still need to
        // resolve via getSpool — only those with a local link but no
        // index entry (and not already cached).
        var links = (App.getConfig().slot_spool_links || {});
        var toFetch = [];
        for (var i = 0; i < channels.length; i++) {
            var ch = channels[i];
            var uid = (ch.tag && ch.tag.scan && ch.tag.scan.uid) || (ch.moonraker && ch.moonraker.CARD_UID);
            var uidStr = Array.isArray(uid) ? formatUid(uid) : (uid ? String(uid) : null);
            if (!uidStr) continue;
            var spoolId = links[uidStr];
            if (!spoolId) continue;
            var cached = _spoolmanCache[ch.channel];
            if (cached && cached.spool_id === spoolId && !cached.error) continue;
            // Skip if the index already has this UID — applyUidSyncIndex
            // covered it.
            if (_uidSyncIndex[uidStr.toUpperCase()]) continue;
            toFetch.push({ channel: ch.channel, spoolId: spoolId });
        }
        if (toFetch.length === 0) return;
        _spoolmanFetchPending = true;
        var remaining = toFetch.length;
        var needRerender = false;
        toFetch.forEach(function (entry) {
            Spoolman.getSpool(entry.spoolId)
                .then(function (spool) {
                    var fil = (spool && spool.filament) || null;
                    if (fil) {
                        _spoolmanCache[entry.channel] = {
                            spool_id: entry.spoolId,
                            filament_id: fil.id,
                            name: fil.name || ('Spool #' + entry.spoolId),
                            density: fil.density || null
                        };
                        needRerender = true;
                    } else {
                        delete _spoolmanCache[entry.channel];
                        needRerender = true;
                    }
                })
                .catch(function (err) {
                    if (err && err.status === 404) {
                        delete _spoolmanCache[entry.channel];
                        needRerender = true;
                        // Self-heal: the spool was deleted in Spoolman.
                        // Drop the matching slot_spool_links entry so we
                        // don't keep 404'ing on every refresh, and so the
                        // user can re-import cleanly. Look up the UID by
                        // walking the link map (cheaper than threading it
                        // through this fetch).
                        var links = (App.getConfig().slot_spool_links || {});
                        var nextLinks = null;
                        Object.keys(links).forEach(function (u) {
                            if (links[u] === entry.spoolId) {
                                if (!nextLinks) nextLinks = Object.assign({}, links);
                                delete nextLinks[u];
                            }
                        });
                        if (nextLinks) {
                            App.saveConfig({ slot_spool_links: nextLinks })
                                .catch(function () {});
                        }
                    } else {
                        _spoolmanCache[entry.channel] = { error: true };
                        needRerender = true;
                    }
                })
                .then(function () {
                    remaining--;
                    if (remaining === 0) {
                        _spoolmanFetchPending = false;
                        if (needRerender) fetchChannels();
                    }
                });
        });
    }

    // Wire up the two live data sources we care about: OpenRFID scan events
    // (UID + filament parse) and Klipper's filament_detect printer object
    // (vendor/material strings). Both call fetchChannels() to repaint.
    function setupSubscriptions() {
        var openrfid = App.openrfid();
        var moonraker = App.moonraker();
        if (_unsubscribeScan) { _unsubscribeScan(); _unsubscribeScan = null; }
        if (_unsubscribeStatus) { _unsubscribeStatus(); _unsubscribeStatus = null; }

        _unsubscribeScan = openrfid.onScan(function () { fetchChannels(); });

        // Subscribe to filament_detect updates pushed via notify_status_update.
        // Moonraker also requires an initial subscribe RPC to register interest.
        moonraker.call('printer.objects.subscribe', {
            objects: { filament_detect: null }
        }).then(function (res) {
            if (res && res.status && res.status.filament_detect) {
                _filamentDetect = res.status.filament_detect;
                fetchChannels();
            }
        }).catch(function () {
            // Filament detect object may not be present; non-fatal.
        });

        _unsubscribeStatus = moonraker.on('notify_status_update', function (params) {
            var update = Array.isArray(params) ? params[0] : params;
            if (!update || !update.filament_detect) return;
            // Shallow merge so partial updates don't blow away cached fields.
            _filamentDetect = Object.assign({}, _filamentDetect, update.filament_detect);
            fetchChannels();
        });
    }

    function fetchSpoolmanStatus(forceRefreshInfoBox) {
        // Fan out status + the three list calls in parallel so the
        // info box only renders ONCE with everything already filled in.
        // Rendering on the status response and again on the count
        // response caused a visible flicker (the second render ran
        // through every cell, briefly showing "—" before settling).
        var statusP = Spoolman.status().catch(function () { return null; });
        var spoolsP = Spoolman.listSpools().catch(function () { return null; });
        var filamentsP = Spoolman.listFilaments().catch(function () { return null; });
        var vendorsP = Spoolman.listVendors().catch(function () { return null; });

        Promise.all([statusP, spoolsP, filamentsP, vendorsP]).then(function (results) {
            var data = results[0];
            var spools = results[1];
            var filaments = results[2];
            var vendors = results[3];

            var dot = document.getElementById('spoolman-status-dot');
            var text = document.getElementById('spoolman-status-text');
            var configured = !!(data && (data.spoolman_connected !== undefined || data.url));
            var ok = !!(data && (data.spoolman_connected || data.ok));
            if (dot && text) {
                if (!configured) {
                    dot.style.display = 'none';
                    text.style.display = 'none';
                } else {
                    dot.style.display = '';
                    text.style.display = '';
                    dot.className = 'status-dot ' + (ok ? 'connected' : 'disconnected');
                }
            }

            var counts = ok ? {
                spools:    Array.isArray(spools)    ? spools.length    : null,
                filaments: Array.isArray(filaments) ? filaments.length : null,
                vendors:   Array.isArray(vendors)   ? vendors.length   : null
            } : null;

            renderSpoolmanInfoBox({
                configured: configured,
                ok: ok,
                url: data && data.url,
                counts: counts
            });
        });
    }

    // ── Spoolman info box ───────────────────────────────────────────────────
    function renderSpoolmanInfoBox(data) {
        var section = document.getElementById('spoolman-info-section');
        if (!section) return;
        if (!data || !data.configured) {
            section.hidden = true;
            return;
        }
        section.hidden = false;
        var urlEl = section.querySelector('[data-id="url"]');
        var statusEl = section.querySelector('[data-id="status-text"]');
        var sp = section.querySelector('[data-id="count-spools"]');
        var fi = section.querySelector('[data-id="count-filaments"]');
        var ve = section.querySelector('[data-id="count-vendors"]');
        if (urlEl && data.url) {
            urlEl.href = data.url;
            urlEl.textContent = data.url.replace(/^https?:\/\//, '');
        }
        if (statusEl) {
            statusEl.textContent = data.ok ? 'connected' : 'unreachable';
            statusEl.style.color = data.ok ? 'var(--success)' : 'var(--accent)';
        }
        var counts = (data.ok && data.counts) ? data.counts : {};
        function fmt(v) { return (v === null || v === undefined) ? '—' : String(v); }
        if (sp) sp.textContent = fmt(counts.spools);
        if (fi) fi.textContent = fmt(counts.filaments);
        if (ve) ve.textContent = fmt(counts.vendors);
    }

    function mount(container) {
        var section = document.createElement('section');
        section.id = 'channels';
        section.className = 'channels-grid';
        container.appendChild(section);

        // Info box lives below the channel grid. Cloned from the template
        // so the markup stays in spools.html. Hidden until the first
        // status response says configured=true.
        var infoBox = Templates.clone('spoolman-info-box');
        infoBox.id = 'spoolman-info-section';
        var refreshBtn = infoBox.querySelector('[data-id="refresh"]');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                refreshBtn.classList.add('spinning');
                fetchSpoolmanStatus();
                setTimeout(function () { refreshBtn.classList.remove('spinning'); }, 800);
            });
        }
        container.appendChild(infoBox);

        fetchSpoolmanStatus();
        setupSubscriptions();
        fetchChannels();
        scanAll();  // Trigger a full RFID scan on page open
    }

    function unmount() {
        if (_unsubscribeScan) { _unsubscribeScan(); _unsubscribeScan = null; }
        if (_unsubscribeStatus) { _unsubscribeStatus(); _unsubscribeStatus = null; }
    }

    function fetchChannels() {
        var config = App.getConfig();
        var openrfid = App.openrfid();
        var moonraker = App.moonraker();
        // Pull both data sources in parallel: openrfid/list_channels gives
        // us the per-slot RFID side (uid, tag_type, parsed filament dict)
        // plus the write-enabled flag, while filament_detect carries the
        // Klipper-side vendor/material strings the channel card relies on.
        Promise.all([
            openrfid.listChannels(),
            moonraker.call('printer.objects.query', { objects: { filament_detect: null } })
                .catch(function () { return null; })
        ]).then(function (results) {
            App.setConnectionStatus(true);
            var lc = results[0] || {};
            var fdResp = results[1] || {};
            _writeEnabled = !!lc.write_enabled;
            var fd = (fdResp.status && fdResp.status.filament_detect) || _filamentDetect || {};
            _filamentDetect = fd;

            var ocChannels = lc.channels || [];
            var fdInfo = fd.info || [];
            var merged = mergeChannels(ocChannels, fdInfo);
            applyUidSyncIndex(merged);
            _channels = merged;

            var container = document.getElementById('channels');
            if (!container) return;
            // Preserve any cards currently in inline-edit mode so live
            // updates don't blow away the user's in-progress changes.
            var preserved = {};
            var existing = container.querySelectorAll('.channel-card');
            for (var p = 0; p < existing.length; p++) {
                var chIdx = existing[p].getAttribute('data-channel');
                if (chIdx !== null && _editingChannels[chIdx]) {
                    preserved[chIdx] = existing[p];
                }
            }
            container.innerHTML = '';
            for (var i = 0; i < merged.length; i++) {
                var key = String(merged[i].channel);
                if (preserved[key]) {
                    container.appendChild(preserved[key]);
                } else {
                    container.appendChild(renderChannel(merged[i], config));
                }
            }
            refreshSpoolmanCache(merged);
            fetchSpoolmanStatus();
        }).catch(function (err) {
            App.setConnectionStatus(false);
            console.error('Failed to fetch channels:', err);
        });
    }

    // Merge the two data sources by slot index. Always emits exactly four
    // entries (slots 0..3) so the grid layout stays stable even when the
    // OpenRFID agent only knows about a subset of them.
    function mergeChannels(ocChannels, fdInfo) {
        var bySlot = {};
        for (var i = 0; i < ocChannels.length; i++) {
            var oc = ocChannels[i];
            bySlot[oc.slot] = oc;
        }
        var out = [];
        for (var s = 0; s < 4; s++) {
            var oc2 = bySlot[s];
            var ls = (oc2 && oc2.last_scan) || null;
            var tag = null;
            if (ls) {
                tag = {
                    scan: { uid: ls.uid },
                    filament: ls.filament || null,
                    unrecognized: !!ls.tag_type && !ls.filament
                };
            }
            out.push({
                channel: s,
                moonraker: fdInfo[s] || {},
                tag: tag
            });
        }
        return out;
    }

    return { mount: mount, unmount: unmount, fetchChannels: fetchChannels };
})();

function scanAll() {
    var btn = document.getElementById('scan-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning\u2026'; }
    var openrfid = App.openrfid();
    if (!openrfid) {
        if (btn) { btn.disabled = false; btn.textContent = 'Scan All'; }
        return;
    }
    // Trigger one scan per slot in parallel. The agent broadcasts the
    // results via notify_agent_event, which our subscription picks up
    // and turns into fetchChannels() repaints.
    Promise.all([0, 1, 2, 3].map(function (slot) {
        return openrfid.scanSlot(slot).catch(function (err) {
            console.warn('Scan slot ' + slot + ' failed:', err && err.message);
            return null;
        });
    })).then(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Scan All'; }
    });
}
