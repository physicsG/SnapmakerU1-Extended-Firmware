'use strict';

// Subscribe to all fields so we get state[] push updates too
const QUERY_OBJECTS = {
    filament_detect: null,
    print_task_config: null,
};

const FD_STATE_IDLE      = 0;
const FD_STATE_DETECTING = 1;

let ws = null;
let wsReady = false;
let requestId = 1;
const pendingRequests = new Map();
let channelsData = [];
let subscribed = false;
let initialized = false;
let refreshing = false;
let spoolmanActive = false;
let spoolmanUrl = null;
let spoolmanSpools = new Map();
let spoolPickerChannel = null;
let spoolRefreshTimer = null;
const SPOOL_REFRESH_ACTIVE_MS = 3000;
const SPOOL_REFRESH_IDLE_MS = 30000;
let spoolPickerSpools = [];
let spoolPickerCurrentId = null;
let spoolPickerContext = null;
let spoolmanFieldStatusRows = [];
let spoolmanSyncContext = null;
let spoolmanSyncPlan = null;
let openRfidAvailable = false;
let openRfidWriteEnabled = false;
let openRfidApi = null;
const openRfidChannelCapabilities = new Map();
const openRfidScans = new Map();
const openRfidSlotGenerations = [0, 0, 0, 0];
let openRfidDiscoveryTimer = null;
let openRfidDiscoveryAttempt = 0;
let tigerTagOptions = null;
let tigerTagAuthoringContext = null;
let tigerTagAuthoringPreview = null;
let tigerTagAuthoringBusy = false;
const tigerTagUncertainOperations = new Map();

const OPENRFID_AGENT = 'openrfid';
const OPENRFID_SCAN_EVENT = 'openrfid/scan';
const OPENRFID_DISCOVERY_MAX_ATTEMPTS = 6;

// Last known full status — merged incrementally from notify_status_update
let cachedStatus = {
    filament_detect: { info: [{}, {}, {}, {}], state: [0, 0, 0, 0] },
    print_task_config: {},
};

document.addEventListener('DOMContentLoaded', () => {
    if (initialized) return;
    initialized = true;
    initializeWebSocket();
    initializeEventListeners();
    initializeModals();
});

// ── WebSocket ─────────────────────────────────────────────────────────────

function initializeWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/websocket`);

    ws.onopen = () => {
        sendRPC('server.connection.identify', {
            client_name: 'filament-manager',
            version: '1.0.0',
            type: 'web',
            url: location.href,
        }).then(() => {
            wsReady = true;
            setConnectionStatus(true);
            loadInitialData();
        }).catch(() => {
            showStatus('Failed to connect to Moonraker', 'error');
        });
    };

    ws.onclose = () => {
        wsReady = false;
        subscribed = false;
        openRfidAvailable = false;
        openRfidWriteEnabled = false;
        openRfidApi = null;
        openRfidChannelCapabilities.clear();
        openRfidScans.clear();
        if (openRfidDiscoveryTimer) clearTimeout(openRfidDiscoveryTimer);
        openRfidDiscoveryTimer = null;
        openRfidDiscoveryAttempt = 0;
        setConnectionStatus(false);
        showStatus('Disconnected — reconnecting…', 'error');
        setTimeout(initializeWebSocket, 2000);
    };

    ws.onerror = () => showStatus('WebSocket error', 'error');

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.method === 'notify_agent_event') {
            const notification = Array.isArray(msg.params) ? msg.params[0] : msg.params;
            if (notification?.agent === OPENRFID_AGENT
                    && notification.event === OPENRFID_SCAN_EVENT) {
                void acceptOpenRfidScan(notification.data || {}, true);
            }
            return;
        }

        // Push update from subscription
        if (msg.method === 'notify_status_update') {
            const update = msg.params[0];
            mergeStatus(update);
            rebuildFromCache();
            return;
        }

        // RPC response
        if (msg.id && pendingRequests.has(msg.id)) {
            const { resolve, reject } = pendingRequests.get(msg.id);
            pendingRequests.delete(msg.id);
            if (msg.error) reject(msg.error); else resolve(msg.result);
        }
    };
}

function sendRPC(method, params = {}) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket not connected'));
            return;
        }
        const id = requestId++;
        pendingRequests.set(id, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Request timeout'));
            }
        }, 30000);
    });
}

async function sendGcode(gcode) {
    try {
        return await sendRPC('printer.gcode.script', { script: gcode });
    } catch (error) {
        if (error.message && error.message.includes('!!')) {
            const m = error.message.match(/!!\s*(.+)/);
            if (m) throw new Error(m[1]);
        }
        throw error;
    }
}

function openRfidRequest(method, arguments_ = {}) {
    return sendRPC('server.extensions.request', {
        agent: OPENRFID_AGENT,
        method,
        arguments: arguments_,
    });
}

function cachedUidForSlot(slot) {
    const info = cachedStatus.filament_detect?.info?.[slot] || {};
    return RfidPort.normalizeUid(info.CARD_UID);
}

function invalidateOpenRfidSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= openRfidSlotGenerations.length) return;
    openRfidSlotGenerations[slot] += 1;
    openRfidScans.delete(slot);
}

function markOpenRfidAvailable() {
    openRfidAvailable = true;
    openRfidDiscoveryAttempt = 0;
    if (openRfidDiscoveryTimer) clearTimeout(openRfidDiscoveryTimer);
    openRfidDiscoveryTimer = null;
}

function scheduleOpenRfidDiscovery() {
    if (!wsReady || openRfidDiscoveryTimer
            || openRfidDiscoveryAttempt >= OPENRFID_DISCOVERY_MAX_ATTEMPTS) return;
    const delay = Math.min(30000, 1000 * (2 ** openRfidDiscoveryAttempt));
    openRfidDiscoveryAttempt += 1;
    openRfidDiscoveryTimer = setTimeout(() => {
        openRfidDiscoveryTimer = null;
        void loadOpenRfidChannels();
    }, delay);
}

async function acceptOpenRfidScan(scan, confirmWithPrinter) {
    const slot = Number(scan?.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= 4) return false;

    const generation = openRfidSlotGenerations[slot];
    let printerUid = cachedUidForSlot(slot);
    if (confirmWithPrinter) {
        try {
            const status = await queryAndSubscribe();
            const confirmedInfo = status?.filament_detect?.info?.[slot] || {};
            const confirmedUid = RfidPort.normalizeUid(confirmedInfo.CARD_UID);
            if (generation !== openRfidSlotGenerations[slot]
                    || confirmedUid !== cachedUidForSlot(slot)) return false;
            printerUid = confirmedUid;
        } catch (_err) {
            return false;
        }
    }

    if (!RfidPort.shouldAcceptScan(scan, printerUid, openRfidScans.get(slot))) return false;

    markOpenRfidAvailable();
    openRfidScans.set(slot, { ...scan, _presenceGeneration: generation });
    rebuildFromCache();
    return true;
}

async function loadOpenRfidChannels() {
    try {
        const result = await openRfidRequest('openrfid/list_channels');
        if (!result || typeof result !== 'object') throw new Error('Invalid OpenRFID channel response');
        markOpenRfidAvailable();
        openRfidApi = result;
        openRfidWriteEnabled = result?.write_enabled === true;
        openRfidChannelCapabilities.clear();
        const channels = Array.isArray(result?.channels) ? result.channels : [];
        for (const channel of channels) {
            const slot = Number(channel?.slot);
            if (Number.isInteger(slot) && slot >= 0) {
                openRfidChannelCapabilities.set(slot, channel.capabilities || {});
            }
            if (channel?.last_scan) await acceptOpenRfidScan(channel.last_scan, false);
        }
        rebuildFromCache();
        return result;
    } catch (_err) {
        openRfidAvailable = false;
        openRfidWriteEnabled = false;
        openRfidApi = null;
        openRfidChannelCapabilities.clear();
        openRfidScans.clear();
        rebuildFromCache();
        scheduleOpenRfidDiscovery();
        return null;
    }
}

async function queryAndSubscribe() {
    if (!subscribed) {
        await sendRPC('printer.objects.subscribe', { objects: QUERY_OBJECTS });
        subscribed = true;
    }
    const result = await sendRPC('printer.objects.query', { objects: QUERY_OBJECTS });
    return result.status;
}

// ── Connection status ─────────────────────────────────────────────────────

function setConnectionStatus(connected) {
    const dot = document.getElementById('connection-status');
    const text = document.getElementById('connection-text');
    if (dot) dot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
    if (text) text.textContent = connected ? 'Connected' : 'Disconnected';
    const btn = document.getElementById('refresh-all');
    if (btn && !refreshing) btn.disabled = !connected;
}

// ── Initial data load (no gcodes — shows existing printer state) ──────────

async function loadSpoolmanStatus() {
    const [statusResult, configResult] = await Promise.allSettled([
        sendRPC('server.spoolman.status'),
        sendRPC('server.config'),
    ]);
    spoolmanActive = statusResult.status === 'fulfilled'
        && statusResult.value?.spoolman_connected === true;
    if (configResult.status === 'fulfilled') {
        spoolmanUrl = configResult.value?.config?.spoolman?.server || null;
    }
    const fieldsButton = document.getElementById('spoolman-fields-button');
    if (fieldsButton) fieldsButton.style.display = spoolmanActive ? '' : 'none';
    if (spoolmanActive && !spoolRefreshTimer) scheduleSpoolRefresh();
}

async function loadInitialData() {
    try {
        const status = await queryAndSubscribe();
        mergeStatus(status);
        rebuildFromCache();
        await loadSpoolmanStatus();
        await loadOpenRfidChannels();
        if (spoolmanActive) await refreshSpoolWeights();
    } catch (err) {
        showStatus(`Load failed: ${err.message}`, 'error');
    }
}

async function fetchSpoolmanAllSpools() {
    try {
        const result = await sendRPC('server.spoolman.proxy', { request_method: 'GET', path: '/v1/spool?limit=1000' });
        return Array.isArray(result) ? result : [];
    } catch { return []; }
}

function spoolmanProxy(requestMethod, path, body) {
    const params = { request_method: requestMethod, path };
    if (body !== undefined) params.body = body;
    return sendRPC('server.spoolman.proxy', params);
}

async function fetchSpoolmanSpool(id) {
    try {
        return await sendRPC('server.spoolman.proxy', { request_method: 'GET', path: `/v1/spool/${id}` });
    } catch { return null; }
}

function setSpoolmanFieldsMessage(message, kind = '') {
    const element = document.getElementById('spoolman-fields-status');
    if (!element) return;
    element.textContent = message || '';
    element.className = 'spoolman-fields-message' + (kind ? ` ${kind}` : '');
}

function renderSpoolmanFieldRows(rows) {
    const container = document.getElementById('spoolman-fields-list');
    container.innerHTML = '';
    const groups = [
        ['core', 'Core - managed by SpoolLink'],
        ['optional', 'Optional RFID metadata'],
        ['legacy', 'Legacy - migration only'],
    ];
    for (const [group, title] of groups) {
        const groupRows = rows.filter(row => row.group === group);
        const heading = document.createElement('h3');
        heading.className = 'spoolman-fields-group-title';
        heading.textContent = title;
        container.appendChild(heading);
        for (const row of groupRows) {
            const item = document.createElement('label');
            item.className = 'spoolman-field-row';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.disabled = !row.selectable;
            checkbox.dataset.fieldKey = `${row.entity}.${row.key}`;
            checkbox.setAttribute('aria-label', `Create ${row.name}`);

            const name = document.createElement('span');
            name.className = 'spoolman-field-name';
            name.textContent = row.name;
            const key = document.createElement('span');
            key.className = 'spoolman-field-key';
            key.textContent = `${row.entity}.${row.key} (${row.expectedType})`;
            name.appendChild(document.createElement('br'));
            name.appendChild(key);

            const status = document.createElement('span');
            status.className = `spoolman-field-status ${row.status.toLowerCase().replace(/\s+/g, '-')}`;
            status.textContent = row.status === 'Type mismatch'
                ? `Type mismatch: ${row.actualType || 'unknown'}`
                : row.status;
            item.append(checkbox, name, status);
            container.appendChild(item);
        }
    }
}

async function loadSpoolmanFieldStatusRows() {
    const [spoolFields, filamentFields] = await Promise.all([
        spoolmanProxy('GET', '/v1/field/spool'),
        spoolmanProxy('GET', '/v1/field/filament'),
    ]);
    return SpoolmanRfidFields.buildFieldStatus({
        spool: spoolFields,
        filament: filamentFields,
    });
}

async function refreshSpoolmanFieldStatus() {
    const list = document.getElementById('spoolman-fields-list');
    list.innerHTML = '<div class="spoolman-loading"><span class="spinner"></span> Reading Spoolman schema...</div>';
    setSpoolmanFieldsMessage('');
    try {
        spoolmanFieldStatusRows = await loadSpoolmanFieldStatusRows();
        renderSpoolmanFieldRows(spoolmanFieldStatusRows);
        return true;
    } catch (err) {
        spoolmanFieldStatusRows = [];
        list.innerHTML = '';
        setSpoolmanFieldsMessage(`Could not read Spoolman fields: ${err.message || err}`, 'error');
        return false;
    }
}

function openSpoolmanFields() {
    openModal('spoolman-fields-modal');
    void refreshSpoolmanFieldStatus();
}

async function addSelectedSpoolmanFields() {
    const selected = new Set(
        [...document.querySelectorAll('#spoolman-fields-list input[data-field-key]:checked')]
            .map(input => input.dataset.fieldKey)
    );
    const definitions = SpoolmanRfidFields.getSelectedMissingOptionalFields(
        spoolmanFieldStatusRows,
        selected
    );
    if (!definitions.length) {
        setSpoolmanFieldsMessage('Select at least one missing optional field.');
        return;
    }

    const button = document.getElementById('spoolman-fields-add');
    button.disabled = true;
    setSpoolmanFieldsMessage('Creating selected fields...');
    const results = await Promise.all(definitions.map(async definition => {
        try {
            await spoolmanProxy(
                'POST',
                `/v1/field/${definition.entity}/${definition.key}`,
                { name: definition.name, field_type: definition.field_type }
            );
            return { definition, ok: true };
        } catch (error) {
            return { definition, ok: false, error };
        }
    }));
    button.disabled = false;

    const failures = results.filter(result => !result.ok);
    const refreshOk = await refreshSpoolmanFieldStatus();
    if (!refreshOk) {
        setSpoolmanFieldsMessage(
            `${results.length - failures.length} field(s) created, but schema verification failed. Refresh and verify before using them.`,
            'error'
        );
        return;
    }
    if (failures.length) {
        const details = failures.map(result =>
            `${result.definition.key}: ${result.error?.message || result.error}`
        ).join('; ');
        setSpoolmanFieldsMessage(
            `${results.length - failures.length} created, ${failures.length} failed - ${details}`,
            'error'
        );
    } else {
        setSpoolmanFieldsMessage(`${results.length} field(s) created.`, 'success');
    }
}

function spoolmanSyncErrorText(error) {
    return error?.message || error?.error?.message || String(error || 'Unknown error');
}

function setSpoolmanSyncMessage(message, kind = '') {
    const element = document.getElementById('spoolman-sync-status');
    if (!element) return;
    element.textContent = message || '';
    element.className = 'spoolman-fields-message' + (kind ? ` ${kind}` : '');
}

function formatSpoolmanSyncValue(row, value, proposed = false) {
    const decoded = row.kind === 'extra'
        ? SpoolmanRfidFields.decodeExtraValue(value)
        : value;
    if (decoded === null || decoded === undefined || decoded === '') {
        return proposed && row.key === 'multi_color_hexes' ? '(clear)' : '(empty)';
    }
    if (row.key === 'color_hex') return `#${String(decoded).replace(/^#/, '').toUpperCase()}`;
    if (row.key === 'multi_color_hexes') {
        return String(decoded).split(',').map(color => `#${color.trim().replace(/^#/, '').toUpperCase()}`).join(', ');
    }
    if (row.key.includes('temp')) return `${decoded} C`;
    if (row.key === 'diameter' || row.key === 'td') return `${decoded} mm`;
    if (row.key === 'drying_time') return `${decoded} h`;
    if (Array.isArray(decoded)) return decoded.join(', ');
    if (decoded && typeof decoded === 'object') return JSON.stringify(decoded);
    return String(decoded);
}

function currentSpoolmanSyncChannel(context = spoolmanSyncContext) {
    if (!context) return null;
    const channel = channelsData.find(item => item.channel === context.channel);
    if (!channel || !channel.decoded || channel.physical?.state !== 'read') return null;
    if (Number(channel.spool_id) !== Number(context.spoolId)) return null;
    if (RfidPort.normalizeUid(channel.physical?.uidHex) !== context.uid) return null;
    if (openRfidSlotGenerations[context.channel] !== context.generation) return null;
    return channel;
}

function selectedSpoolmanSyncIds() {
    return new Set(
        [...document.querySelectorAll('#spoolman-sync-list input[data-sync-id]:checked')]
            .map(input => input.dataset.syncId)
    );
}

function updateSpoolmanSyncSelectionMessage() {
    const button = document.getElementById('spoolman-sync-apply');
    if (!spoolmanSyncPlan?.ok) {
        button.disabled = true;
        return;
    }
    const selected = SpoolmanRfidFields.selectedSyncRows(
        spoolmanSyncPlan,
        selectedSpoolmanSyncIds()
    );
    button.disabled = selected.length === 0;
    const conflicts = selected.filter(row => row.conflict).length;
    setSpoolmanSyncMessage(
        selected.length
            ? `${selected.length} field(s) selected${conflicts ? `; ${conflicts} existing value(s) will be replaced after confirmation` : ''}.`
            : 'Select at least one changed field. Different non-empty values are unchecked by default.'
    );
}

function renderSpoolmanSyncPlan(plan) {
    const container = document.getElementById('spoolman-sync-list');
    container.innerHTML = '';
    const groups = [
        ['native', 'Spoolman filament fields'],
        ['extra', 'Registered RFID metadata fields'],
    ];

    for (const [kind, title] of groups) {
        const rows = plan.rows.filter(row => row.kind === kind);
        if (!rows.length) continue;
        const heading = document.createElement('h3');
        heading.className = 'spoolman-fields-group-title';
        heading.textContent = title;
        container.appendChild(heading);

        for (const row of rows) {
            const item = document.createElement('label');
            item.className = `spoolman-sync-row ${row.state}`;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.disabled = !row.selectable;
            checkbox.checked = row.selectedByDefault;
            checkbox.dataset.syncId = row.id;
            checkbox.setAttribute('aria-label', `Sync ${row.label}`);
            checkbox.addEventListener('change', updateSpoolmanSyncSelectionMessage);

            const details = document.createElement('span');
            details.className = 'spoolman-sync-details';
            const name = document.createElement('span');
            name.className = 'spoolman-sync-name';
            name.textContent = row.label;
            const key = document.createElement('span');
            key.className = 'spoolman-field-key';
            key.textContent = row.id;
            const values = document.createElement('span');
            values.className = 'spoolman-sync-values';
            const current = document.createElement('span');
            current.textContent = `Current: ${formatSpoolmanSyncValue(row, row.current)}`;
            const proposed = document.createElement('span');
            proposed.textContent = `Tag: ${formatSpoolmanSyncValue(row, row.value, true)}`;
            values.append(current, proposed);
            details.append(name, key, values);

            const state = document.createElement('span');
            state.className = `spoolman-sync-state ${row.state}`;
            state.textContent = row.state === 'add' ? 'New'
                : row.state === 'conflict' ? 'Different'
                    : row.state === 'same' ? 'Same' : 'Unavailable';
            state.title = row.note || '';
            item.append(checkbox, details, state);
            container.appendChild(item);
        }
    }
    updateSpoolmanSyncSelectionMessage();
}

async function loadCurrentSpoolmanSyncPlan(context = spoolmanSyncContext) {
    if (!currentSpoolmanSyncChannel(context)) {
        throw new Error('The scanned tag or assigned spool changed; reopen the preview.');
    }
    const [spool, statusRows] = await Promise.all([
        spoolmanProxy('GET', `/v1/spool/${context.spoolId}`),
        loadSpoolmanFieldStatusRows(),
    ]);
    if (!currentSpoolmanSyncChannel(context)) {
        throw new Error('The scanned tag or assigned spool changed while loading.');
    }
    const channel = currentSpoolmanSyncChannel(context);
    const plan = SpoolmanRfidFields.buildMetadataSyncPlan(
        channel.decoded,
        channel.physical,
        spool,
        statusRows
    );
    if (!plan.ok) throw new Error(plan.errors.join('; '));
    return { plan, spool, statusRows };
}

async function openSpoolmanMetadataSync(channelNumber) {
    const channel = channelsData.find(item => item.channel === channelNumber);
    if (!spoolmanActive) {
        showStatus('Spoolman is not connected', 'error');
        return;
    }
    if (!channel?.decoded || channel.physical?.state !== 'read') {
        showStatus('Read a supported tag with OpenRFID before syncing metadata', 'error');
        return;
    }
    if (channel.spool_id == null) {
        showStatus('Assign a Spoolman spool before syncing metadata', 'error');
        return;
    }
    const uid = RfidPort.normalizeUid(channel.physical?.uidHex);
    if (!uid) {
        showStatus('The current scan has no verified card UID', 'error');
        return;
    }

    spoolmanSyncContext = {
        channel: channelNumber,
        spoolId: channel.spool_id,
        uid,
        generation: openRfidSlotGenerations[channelNumber],
    };
    spoolmanSyncPlan = null;
    document.getElementById('spoolman-sync-title').textContent =
        `Sync Tag to Spoolman - Extruder ${channelNumber + 1}`;
    document.getElementById('spoolman-sync-intro').textContent =
        `Previewing tag metadata for spool #${channel.spool_id}. UID ownership is unchanged and remains managed by SpoolLink.`;
    document.getElementById('spoolman-sync-list').innerHTML =
        '<div class="spoolman-loading"><span class="spinner"></span> Loading tag, spool, and field schema...</div>';
    document.getElementById('spoolman-sync-apply').disabled = true;
    setSpoolmanSyncMessage('');
    openModal('spoolman-sync-modal');

    const context = spoolmanSyncContext;
    try {
        const loaded = await loadCurrentSpoolmanSyncPlan(context);
        if (spoolmanSyncContext !== context) return;
        spoolmanSyncPlan = loaded.plan;
        renderSpoolmanSyncPlan(spoolmanSyncPlan);
    } catch (error) {
        if (spoolmanSyncContext !== context) return;
        spoolmanSyncPlan = null;
        document.getElementById('spoolman-sync-list').innerHTML = '';
        setSpoolmanSyncMessage(`Cannot build sync preview: ${spoolmanSyncErrorText(error)}`, 'error');
    }
}

function closeSpoolmanMetadataSync() {
    spoolmanSyncContext = null;
    spoolmanSyncPlan = null;
    closeModal('spoolman-sync-modal');
}

async function applySpoolmanMetadataSync() {
    if (!spoolmanSyncContext || !spoolmanSyncPlan?.ok) return;
    const context = spoolmanSyncContext;
    const requestedIds = selectedSpoolmanSyncIds();
    if (!requestedIds.size) {
        setSpoolmanSyncMessage('Select at least one changed field.', 'error');
        return;
    }

    const button = document.getElementById('spoolman-sync-apply');
    button.disabled = true;
    setSpoolmanSyncMessage('Rechecking the tag, spool, and schema before writing...');
    try {
        const loaded = await loadCurrentSpoolmanSyncPlan(context);
        if (spoolmanSyncContext !== context) return;
        const latestPlan = loaded.plan;
        const availableIds = new Set(
            latestPlan.rows.filter(row => row.selectable).map(row => row.id)
        );
        const changedIds = new Set([...requestedIds].filter(id => availableIds.has(id)));
        const unavailable = [...requestedIds].filter(id => !availableIds.has(id));
        if (unavailable.length) {
            throw new Error(`Field availability changed: ${unavailable.join(', ')}. Review the preview again.`);
        }

        const selectedRows = SpoolmanRfidFields.selectedSyncRows(latestPlan, changedIds);
        const conflicts = selectedRows.filter(row => row.conflict);
        if (conflicts.length && !window.confirm(
            `Replace ${conflicts.length} different non-empty Spoolman value(s)?\n\n` +
            conflicts.map(row => row.label).join('\n')
        )) {
            spoolmanSyncPlan = latestPlan;
            renderSpoolmanSyncPlan(latestPlan);
            setSpoolmanSyncMessage('No changes written. Review and select fields to continue.');
            return;
        }

        const built = SpoolmanRfidFields.buildFilamentPatch(latestPlan, changedIds, true);
        setSpoolmanSyncMessage(`Writing ${built.rows.length} selected field(s)...`);
        await spoolmanProxy('PATCH', `/v1/filament/${built.filamentId}`, built.patch);
        const verifiedSpool = await spoolmanProxy('GET', `/v1/spool/${context.spoolId}`);
        const verification = SpoolmanRfidFields.verifyFilamentPatch(
            latestPlan,
            changedIds,
            verifiedSpool
        );
        if (!verification.ok) {
            throw new Error(`Spoolman read-back did not match: ${verification.mismatches.join(', ')}`);
        }

        spoolmanSpools.set(context.spoolId, verifiedSpool);
        if (spoolmanSyncContext === context) {
            const currentChannel = currentSpoolmanSyncChannel(context);
            spoolmanSyncPlan = SpoolmanRfidFields.buildMetadataSyncPlan(
                currentChannel?.decoded,
                currentChannel?.physical,
                verifiedSpool,
                loaded.statusRows
            );
            if (spoolmanSyncPlan.ok) renderSpoolmanSyncPlan(spoolmanSyncPlan);
            setSpoolmanSyncMessage(
                `${verification.verified.length} field(s) synced and verified. UID ownership was not changed.`,
                'success'
            );
        }
        showStatus(`Spool #${context.spoolId} metadata synced`, 'success');
    } catch (error) {
        if (spoolmanSyncContext === context) {
            setSpoolmanSyncMessage(`Sync failed: ${spoolmanSyncErrorText(error)}`, 'error');
        }
        showStatus(`Spoolman metadata sync failed: ${spoolmanSyncErrorText(error)}`, 'error');
    } finally {
        if (spoolmanSyncContext === context && spoolmanSyncPlan?.ok) {
            button.disabled = SpoolmanRfidFields.selectedSyncRows(
                spoolmanSyncPlan,
                selectedSpoolmanSyncIds()
            ).length === 0;
        } else {
            button.disabled = true;
        }
    }
}

function openRfidResultError(result, fallback) {
    if (!result || typeof result !== 'object') return fallback;
    const detail = result.error || result.message || fallback;
    return result.code ? `${detail} (${result.code})` : detail;
}

function requireOpenRfidResult(result, fallback) {
    if (!result || result.ok !== true) throw new Error(openRfidResultError(result, fallback));
    return result;
}

async function loadTigerTagOptions(force = false) {
    if (tigerTagOptions && !force) return tigerTagOptions;
    const result = requireOpenRfidResult(
        await openRfidRequest('openrfid/tigertag_options'),
        'TigerTag registry options are unavailable'
    );
    const groups = ['materials', 'brands', 'aspects', 'types', 'diameters', 'units'];
    if (groups.some(group => !Array.isArray(result[group]))) {
        throw new Error('OpenRFID returned an incomplete TigerTag registry');
    }
    tigerTagOptions = result;
    return result;
}

function tigerTagOptionLabel(group, value) {
    return TigerTagAuthoring.optionRecord(tigerTagOptions, group, value)?.label || String(value ?? '');
}

function populateTigerTagSelect(elementId, group, optional) {
    const select = document.getElementById(elementId);
    select.innerHTML = '';
    if (optional) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'Not set (ID 0)';
        select.appendChild(empty);
    }
    for (const record of tigerTagOptions[group]) {
        const option = document.createElement('option');
        option.value = String(record.id);
        option.textContent = `${record.label} (${record.id})`;
        select.appendChild(option);
    }
}

function populateTigerTagRegistryControls() {
    populateTigerTagSelect('tigertag-product-type', 'types', true);
    populateTigerTagSelect('tigertag-material', 'materials', false);
    populateTigerTagSelect('tigertag-brand', 'brands', true);
    populateTigerTagSelect('tigertag-aspect-1', 'aspects', true);
    populateTigerTagSelect('tigertag-aspect-2', 'aspects', true);
    populateTigerTagSelect('tigertag-diameter', 'diameters', true);
    populateTigerTagSelect('tigertag-unit', 'units', true);
    const sdk = tigerTagOptions.sdk || {};
    document.getElementById('tigertag-sdk').textContent = [
        sdk.name || 'TigerTag SDK',
        sdk.version ? `v${sdk.version}` : '',
        sdk.commit ? `@${String(sdk.commit).slice(0, 8)}` : '',
    ].filter(Boolean).join(' ');
}

function setTigerTagSelect(elementId, group, value) {
    const select = document.getElementById(elementId);
    const record = TigerTagAuthoring.optionRecord(tigerTagOptions, group, value);
    select.value = record ? String(record.id) : '';
}

function defaultTigerTagDraft() {
    const find = (group, labels) => {
        for (const label of labels) {
            const record = TigerTagAuthoring.optionRecord(tigerTagOptions, group, label);
            if (record) return record;
        }
        return tigerTagOptions[group][0] || null;
    };
    const material = find('materials', ['PLA']);
    const recommended = material?.recommended || {};
    return {
        inventoryName: '',
        material: material?.id ?? '',
        brand: find('brands', ['Generic', 'None'])?.id ?? '',
        aspect1: find('aspects', ['Basic', '-'])?.id ?? '',
        aspect2: find('aspects', ['-', 'None'])?.id ?? '',
        productType: find('types', ['Filament'])?.id ?? '',
        diameter: find('diameters', ['1.75'])?.id ?? '',
        colors: ['FFFFFF'],
        storedColors: ['FFFFFF', '000000', '000000'],
        primaryColorAlpha: 255,
        measure: 1000,
        measureAvailable: 1000,
        unit: find('units', ['g', 'Gram'])?.id ?? '',
        nozzleMin: recommended.nozzleTempMin ?? 190,
        nozzleMax: recommended.nozzleTempMax ?? 230,
        dryTemp: recommended.dryTemp ?? 50,
        dryTime: recommended.dryTime ?? 8,
        bedMin: recommended.bedTempMin ?? 45,
        bedMax: recommended.bedTempMax ?? 60,
        manufacturingDate: new Date().toISOString().slice(0, 10),
        tdMm: 0,
        message: '',
    };
}

function tigerTagColorCount() {
    const first = TigerTagAuthoring.optionRecord(
        tigerTagOptions, 'aspects', document.getElementById('tigertag-aspect-1').value
    );
    const second = TigerTagAuthoring.optionRecord(
        tigerTagOptions, 'aspects', document.getElementById('tigertag-aspect-2').value
    );
    const firstCount = Number(first?.color_count || 0);
    const secondCount = Number(second?.color_count || 0);
    if (secondCount > 1) return Math.min(secondCount, 3);
    if (firstCount > 1) return Math.min(firstCount, 3);
    return 1;
}

function updateTigerTagColorActivity() {
    if (!tigerTagOptions) return;
    const active = tigerTagColorCount();
    for (let index = 1; index <= 3; index++) {
        const input = document.getElementById(`tigertag-color-${index}`);
        input.closest('label').classList.toggle('inactive', index > active);
    }
    document.getElementById('tigertag-color-hint').textContent =
        `${active} active color${active === 1 ? '' : 's'} from the selected aspects. Dormant colors remain stored for lossless editing.`;
}

function setTigerTagMessageByteCount() {
    const message = document.getElementById('tigertag-message').value;
    const bytes = TigerTagAuthoring.utf8ByteLength(message);
    const element = document.getElementById('tigertag-message-bytes');
    element.textContent = `${bytes} / 28 UTF-8 bytes`;
    element.classList.toggle('error', bytes > 28);
}

function applyTigerTagDraft(draft, source) {
    if (!tigerTagAuthoringContext) return;
    const normalized = { ...defaultTigerTagDraft(), ...(draft || {}) };
    const storedColors = Array.isArray(normalized.storedColors)
        ? normalized.storedColors.slice(0, 3)
        : (Array.isArray(normalized.colors) ? normalized.colors.slice(0, 3) : []);
    while (storedColors.length < 3) storedColors.push('000000');
    normalized.storedColors = storedColors;
    tigerTagAuthoringContext.draft = normalized;
    tigerTagAuthoringContext.source = source;
    tigerTagAuthoringPreview = null;

    setTigerTagSelect('tigertag-product-type', 'types', normalized.productType);
    setTigerTagSelect('tigertag-material', 'materials', normalized.material);
    setTigerTagSelect('tigertag-brand', 'brands', normalized.brand);
    setTigerTagSelect('tigertag-aspect-1', 'aspects', normalized.aspect1);
    setTigerTagSelect('tigertag-aspect-2', 'aspects', normalized.aspect2);
    setTigerTagSelect('tigertag-diameter', 'diameters', normalized.diameter);
    setTigerTagSelect('tigertag-unit', 'units', normalized.unit);
    storedColors.forEach((color, index) => {
        const normalizedColor = TigerTagAuthoring.normalizeColor(color) || '000000';
        document.getElementById(`tigertag-color-${index + 1}`).value = `#${normalizedColor}`;
    });
    document.getElementById('tigertag-color-alpha').value =
        normalized.primaryColorAlpha ?? normalized.colorAlpha ?? normalized.alpha ?? 255;
    document.getElementById('tigertag-measure').value = normalized.measure ?? 0;
    document.getElementById('tigertag-measure-available').value = normalized.measureAvailable ?? 0;
    document.getElementById('tigertag-nozzle-min').value = normalized.nozzleMin ?? 0;
    document.getElementById('tigertag-nozzle-max').value = normalized.nozzleMax ?? 0;
    document.getElementById('tigertag-bed-min').value = normalized.bedMin ?? 0;
    document.getElementById('tigertag-bed-max').value = normalized.bedMax ?? 0;
    document.getElementById('tigertag-dry-temp').value = normalized.dryTemp ?? 0;
    document.getElementById('tigertag-dry-time').value = normalized.dryTime ?? 0;
    document.getElementById('tigertag-manufacturing-date').value =
        String(normalized.manufacturingDate || '').slice(0, 10);
    document.getElementById('tigertag-td').value = normalized.tdMm ?? 0;
    document.getElementById('tigertag-message').value = normalized.message || '';

    const inventoryName = String(normalized.inventoryName ||
        tigerTagAuthoringContext.spool?.filament?.name || '').trim();
    const inventoryElement = document.getElementById('tigertag-inventory-name');
    inventoryElement.style.display = inventoryName ? '' : 'none';
    inventoryElement.textContent = inventoryName
        ? `Spoolman inventory name: ${inventoryName}. It is not copied to the on-tag message automatically.`
        : '';
    document.getElementById('tigertag-form').style.display = '';
    document.getElementById('tigertag-preview').style.display = 'none';
    document.getElementById('tigertag-validation').textContent = '';
    updateTigerTagColorActivity();
    setTigerTagMessageByteCount();
    updateTigerTagAuthoringGate();
}

function collectTigerTagDraft() {
    const base = tigerTagAuthoringContext?.draft || {};
    const manufacturingDate = document.getElementById('tigertag-manufacturing-date').value;
    const draft = {
        ...base,
        productType: document.getElementById('tigertag-product-type').value,
        material: document.getElementById('tigertag-material').value,
        brand: document.getElementById('tigertag-brand').value,
        aspect1: document.getElementById('tigertag-aspect-1').value,
        aspect2: document.getElementById('tigertag-aspect-2').value,
        diameter: document.getElementById('tigertag-diameter').value,
        storedColors: [1, 2, 3].map(index =>
            document.getElementById(`tigertag-color-${index}`).value.replace(/^#/, '').toUpperCase()),
        primaryColorAlpha: document.getElementById('tigertag-color-alpha').value,
        measure: document.getElementById('tigertag-measure').value,
        measureAvailable: document.getElementById('tigertag-measure-available').value,
        unit: document.getElementById('tigertag-unit').value,
        nozzleMin: document.getElementById('tigertag-nozzle-min').value,
        nozzleMax: document.getElementById('tigertag-nozzle-max').value,
        bedMin: document.getElementById('tigertag-bed-min').value,
        bedMax: document.getElementById('tigertag-bed-max').value,
        dryTemp: document.getElementById('tigertag-dry-temp').value,
        dryTime: document.getElementById('tigertag-dry-time').value,
        manufacturingDate,
        tdMm: document.getElementById('tigertag-td').value,
        message: document.getElementById('tigertag-message').value,
    };
    draft.colors = draft.storedColors.slice(0, tigerTagColorCount());
    if (manufacturingDate !== String(base.manufacturingDate || '').slice(0, 10)) {
        delete draft.timestamp;
    }
    return draft;
}

function currentTigerTagAuthoringChannel(context = tigerTagAuthoringContext) {
    if (!context) return null;
    const channel = channelsData.find(item => item.channel === context.channel);
    if (!channel) return null;
    if (openRfidSlotGenerations[context.channel] !== context.generation) return null;
    if (TigerTagAuthoring.normalizeUid(channel.physical?.uidHex) !== context.uid) return null;
    return channel;
}

function setTigerTagAuthoringMessage(message, kind = '') {
    const element = document.getElementById('tigertag-validation');
    element.textContent = message || '';
    element.className = 'spoolman-fields-message' + (kind ? ` ${kind}` : '');
}

function tigerTagInitializationOverride() {
    return document.getElementById('tigertag-allow-unrecognized').checked;
}

function tigerTagLegacyMigrationOverride() {
    return document.getElementById('tigertag-allow-legacy').checked;
}

function updateTigerTagAuthoringGate() {
    if (!tigerTagAuthoringContext) return;
    const channel = currentTigerTagAuthoringChannel();
    const format = channel?.tag_format || 'unknown';
    const initializeRow = document.getElementById('tigertag-initialize-row');
    const legacyRow = document.getElementById('tigertag-legacy-row');
    const needsInitialization = format !== 'tigertag';
    const needsLegacyMigration = TigerTagAuthoring.migratableLegacyTag(channel);
    initializeRow.style.display = needsInitialization ? '' : 'none';
    if (!needsInitialization) document.getElementById('tigertag-allow-unrecognized').checked = false;
    legacyRow.style.display = needsLegacyMigration ? '' : 'none';
    if (!needsLegacyMigration) document.getElementById('tigertag-allow-legacy').checked = false;
    document.getElementById('tigertag-allow-unrecognized').disabled =
        tigerTagAuthoringBusy || openRfidApi?.allow_unrecognized_write !== true;
    document.getElementById('tigertag-allow-legacy').disabled =
        tigerTagAuthoringBusy || openRfidApi?.allow_legacy_migration_write !== true;

    const gate = TigerTagAuthoring.authoringGate(
        openRfidApi,
        channel,
        tigerTagInitializationOverride(),
        tigerTagLegacyMigrationOverride()
    );
    const globalCapabilities = openRfidApi?.capabilities || {};
    if (globalCapabilities.tigertag_options !== true) gate.reasons.push('TigerTag registry options are unavailable');
    if (globalCapabilities.tigertag_encode !== true) gate.reasons.push('TigerTag encoding is unavailable');
    if (globalCapabilities.expected_uid_required !== true
            || globalCapabilities.expected_format !== 'tigertag'
            || globalCapabilities.print_state_guard !== true) {
        gate.reasons.push('OpenRFID does not advertise the required UID, format, and print-state guards');
    }
    const uncertain = tigerTagUncertainOperations.get(tigerTagAuthoringContext.channel);
    if (uncertain) {
        gate.reasons.push(`Operation ${uncertain.operationId} has an uncertain outcome; do not retry until its status and a fresh scan are verified`);
    }
    gate.ok = gate.reasons.length === 0;

    const gateElement = document.getElementById('tigertag-gate');
    gateElement.className = `spoolman-picker-warning${gate.ok ? '' : ' conflict'}`;
    gateElement.textContent = gate.ok
        ? `Ready for guarded Maker writes to UID ${gate.uid}; printer state: ${openRfidApi?.print_state || 'unknown'}.`
        : gate.reasons.join(' ');
    const canClear = gate.ok && globalCapabilities.tigertag_clear === true;
    document.getElementById('tigertag-clear').disabled = tigerTagAuthoringBusy || !canClear;
    document.getElementById('tigertag-confirm-write').disabled =
        tigerTagAuthoringBusy || !gate.ok || !tigerTagAuthoringPreview;
    document.getElementById('tigertag-review').disabled = tigerTagAuthoringBusy ||
        !gate.ok || globalCapabilities.tigertag_encode !== true;
    return gate;
}

function setTigerTagOperationMessage(message, kind = '') {
    const element = document.getElementById('tigertag-operation-status');
    element.textContent = message || '';
    element.className = 'spoolman-fields-message' + (kind ? ' ' + kind : '');
}

function updateTigerTagSourceButtons() {
    const context = tigerTagAuthoringContext;
    const channel = currentTigerTagAuthoringChannel(context);
    document.getElementById('tigertag-source-tag').disabled = tigerTagAuthoringBusy ||
        !channel?.decoded || channel.tag_format !== 'tigertag';
    document.getElementById('tigertag-source-spool').disabled = tigerTagAuthoringBusy ||
        !context?.spool;
}

function setTigerTagAuthoringBusy(busy) {
    tigerTagAuthoringBusy = busy === true;
    document.querySelectorAll('#tigertag-form fieldset input, #tigertag-form fieldset select, #tigertag-form fieldset textarea')
        .forEach(element => { element.disabled = tigerTagAuthoringBusy; });
    document.getElementById('tigertag-close').disabled = tigerTagAuthoringBusy;
    document.getElementById('tigertag-cancel').disabled = tigerTagAuthoringBusy;
    document.getElementById('tigertag-preview-back').disabled = tigerTagAuthoringBusy;
    updateTigerTagSourceButtons();
    updateTigerTagAuthoringGate();
}

function closeTigerTagEditor() {
    if (tigerTagAuthoringBusy) return;
    tigerTagAuthoringContext = null;
    tigerTagAuthoringPreview = null;
    closeModal('tigertag-modal');
}

async function openTigerTagEditor(channelNumber) {
    const channel = channelsData.find(item => item.channel === channelNumber);
    const uid = TigerTagAuthoring.normalizeUid(channel?.physical?.uidHex);
    if (!channel || !uid || channel.physical?.hardwareType !== 'ultralight') {
        showStatus('TigerTag writing requires a present Ultralight / NTAG with a 7-byte UID', 'error');
        return;
    }

    const context = {
        channel: channelNumber,
        uid,
        generation: openRfidSlotGenerations[channelNumber],
        spoolId: channel.spool_id,
        spool: channel.spool_id != null ? spoolmanSpools.get(channel.spool_id) || null : null,
        draft: null,
        source: '',
    };
    tigerTagAuthoringContext = context;
    tigerTagAuthoringPreview = null;
    document.getElementById('tigertag-title').textContent =
        'TigerTag Editor - Extruder ' + (channelNumber + 1);
    document.getElementById('tigertag-allow-unrecognized').checked = false;
    document.getElementById('tigertag-allow-legacy').checked = false;
    document.getElementById('tigertag-form').style.display = 'none';
    document.getElementById('tigertag-preview').style.display = 'none';
    document.getElementById('tigertag-inventory-name').style.display = 'none';
    document.getElementById('tigertag-sdk').textContent = 'Loading pinned TigerTag registry...';
    setTigerTagAuthoringMessage('Checking server and reader capabilities...', '');
    setTigerTagOperationMessage('');
    openModal('tigertag-modal');
    setTigerTagAuthoringBusy(true);

    try {
        const spoolPromise = context.spoolId != null && spoolmanActive
            ? fetchSpoolmanSpool(context.spoolId).then(spool => spool || context.spool)
            : Promise.resolve(context.spool);
        const [api, _options, spool] = await Promise.all([
            loadOpenRfidChannels(),
            loadTigerTagOptions(),
            spoolPromise,
        ]);
        if (tigerTagAuthoringContext !== context) return;
        if (!api) throw new Error('OpenRFID authoring API is unavailable');
        const current = currentTigerTagAuthoringChannel(context);
        if (!current) throw new Error('The tag changed while the editor was loading');

        context.spool = spool || null;
        if (context.spool?.id != null) spoolmanSpools.set(context.spool.id, context.spool);
        populateTigerTagRegistryControls();

        if (current.tag_format === 'tigertag' && current.decoded) {
            applyTigerTagDraft(
                TigerTagAuthoring.draftFromTag(current),
                'Current ' + (current.decoded.formatData?.variant || 'TigerTag') + ' payload'
            );
        } else if (context.spool) {
            applyTigerTagDraft(
                TigerTagAuthoring.draftFromSpool(context.spool, false),
                'Assigned Spoolman spool #' + context.spool.id
            );
        } else {
            applyTigerTagDraft(defaultTigerTagDraft(), 'New TigerTag Maker draft');
        }
    } catch (error) {
        if (tigerTagAuthoringContext === context) {
            document.getElementById('tigertag-form').style.display = 'none';
            setTigerTagAuthoringMessage('Editor unavailable: ' + openRfidResultError(error, error.message), 'error');
        }
    } finally {
        if (tigerTagAuthoringContext === context) setTigerTagAuthoringBusy(false);
    }
}

function loadTigerTagSourceFromTag() {
    const channel = currentTigerTagAuthoringChannel();
    if (!channel?.decoded || channel.tag_format !== 'tigertag') {
        setTigerTagAuthoringMessage('The current tag no longer has a decodable TigerTag payload', 'error');
        return;
    }
    document.getElementById('tigertag-allow-unrecognized').checked = false;
    applyTigerTagDraft(
        TigerTagAuthoring.draftFromTag(channel),
        'Current ' + (channel.decoded.formatData?.variant || 'TigerTag') + ' payload'
    );
}

function loadTigerTagSourceFromSpool() {
    const context = tigerTagAuthoringContext;
    if (!context?.spool) {
        setTigerTagAuthoringMessage('No assigned Spoolman spool is available', 'error');
        return;
    }
    applyTigerTagDraft(
        TigerTagAuthoring.draftFromSpool(context.spool, false),
        'Assigned Spoolman spool #' + context.spool.id
    );
}

function renderTigerTagWritePreview(preview) {
    const encoded = preview.encoded;
    const spec = preview.spec;
    const content = document.getElementById('tigertag-preview-content');
    content.innerHTML = '';
    const rows = [
        { label: 'Source', value: preview.source },
        { label: 'Product type', value: tigerTagOptionLabel('types', spec.type) },
        { label: 'Material', value: tigerTagOptionLabel('materials', spec.material) },
        { label: 'Brand', value: tigerTagOptionLabel('brands', spec.brand) },
        { label: 'Primary aspect', value: tigerTagOptionLabel('aspects', spec.aspect_1) },
        { label: 'Secondary aspect', value: tigerTagOptionLabel('aspects', spec.aspect_2) },
        { label: 'Diameter', value: tigerTagOptionLabel('diameters', spec.diameter) + ' mm' },
        { label: 'Stored colors', value: spec.colors.join(', ') },
        { label: 'Initial / available', value: spec.measure + ' / ' + spec.measure_available + ' ' + tigerTagOptionLabel('units', spec.unit) },
        { label: 'Nozzle', value: spec.temp_min_c + '-' + spec.temp_max_c + ' C' },
        { label: 'Bed', value: spec.bed_temp_min_c + '-' + spec.bed_temp_max_c + ' C' },
        { label: 'Drying', value: spec.dry_temp_c + ' C for ' + spec.dry_time_h + ' h' },
        { label: spec.timestamp != null ? 'Raw timestamp' : 'Manufacturing date', value: spec.timestamp != null ? String(spec.timestamp) : String(spec.manufacturing_date || '(not set)') },
        { label: 'Transmission distance', value: spec.td_mm === 0 ? 'Unknown (0)' : spec.td_mm + ' mm' },
        { label: 'Tag message', value: spec.message || '(empty)' },
    ];
    appendDetailsSection(content, 'Encoded TigerTag Maker fields', rows);
    if (preview.validation.inventoryName) {
        appendDetailsSection(content, 'Not written to the tag', [{
            label: 'Spoolman inventory name',
            value: preview.validation.inventoryName,
        }]);
    }

    const uidDisplay = preview.uid.match(/.{2}/g).join(':');
    document.getElementById('tigertag-preview-target').textContent =
        'Extruder ' + (preview.channel + 1) + ', UID ' + uidDisplay
        + ': overwrite pages ' + encoded.start_page + '-' + encoded.end_page
        + ' (' + encoded.bytes + ' bytes).';
    const hex = encoded.data_hex.toUpperCase();
    const pageLines = [];
    for (let page = 0; page < encoded.pages; page++) {
        pageLines.push(
            String(encoded.start_page + page).padStart(2, '0') + ': '
            + hex.slice(page * 8, page * 8 + 8)
        );
    }
    document.getElementById('tigertag-preview-hex').textContent = pageLines.join('\n');
    document.getElementById('tigertag-form').style.display = 'none';
    document.getElementById('tigertag-preview').style.display = '';
    setTigerTagOperationMessage('Review the target UID and every field before confirming.');
    updateTigerTagAuthoringGate();
}

async function reviewTigerTagWrite(event) {
    event?.preventDefault();
    const context = tigerTagAuthoringContext;
    if (!context || !currentTigerTagAuthoringChannel(context)) {
        setTigerTagAuthoringMessage('The tag changed; close the editor and scan again', 'error');
        return;
    }
    const gate = updateTigerTagAuthoringGate();
    if (!gate?.ok) {
        setTigerTagAuthoringMessage('Writing is blocked: ' + gate.reasons.join(' '), 'error');
        return;
    }

    const draft = collectTigerTagDraft();
    const validation = TigerTagAuthoring.validateDraft(draft, tigerTagOptions);
    context.draft = draft;
    if (!validation.ok) {
        tigerTagAuthoringPreview = null;
        setTigerTagAuthoringMessage(validation.errors.join(' '), 'error');
        return;
    }

    setTigerTagAuthoringBusy(true);
    setTigerTagAuthoringMessage('Encoding with the pinned TigerTag SDK...', '');
    try {
        const encoded = requireOpenRfidResult(
            await openRfidRequest('openrfid/tigertag_encode', { spec: validation.spec }),
            'TigerTag encoding failed'
        );
        if (tigerTagAuthoringContext !== context || !currentTigerTagAuthoringChannel(context)) {
            throw new Error('The target tag changed during encoding');
        }
        if (encoded.tag_format !== 'tigertag' || encoded.tag_variant !== 'maker'
                || encoded.start_page !== 4 || encoded.end_page !== 23
                || encoded.bytes !== 80 || encoded.pages !== 20
                || !/^[0-9a-f]{160}$/i.test(encoded.data_hex || '')) {
            throw new Error('OpenRFID returned an invalid TigerTag Maker preview');
        }
        tigerTagAuthoringPreview = {
            context,
            channel: context.channel,
            uid: context.uid,
            generation: context.generation,
            source: context.source,
            validation,
            spec: validation.spec,
            encoded,
            allowUnrecognized: tigerTagInitializationOverride(),
            allowLegacyMigration: tigerTagLegacyMigrationOverride(),
        };
        setTigerTagAuthoringMessage('');
        renderTigerTagWritePreview(tigerTagAuthoringPreview);
    } catch (error) {
        tigerTagAuthoringPreview = null;
        setTigerTagAuthoringMessage('Preview failed: ' + openRfidResultError(error, error.message), 'error');
    } finally {
        if (tigerTagAuthoringContext === context) setTigerTagAuthoringBusy(false);
    }
}

function backToTigerTagEditor() {
    if (tigerTagAuthoringBusy) return;
    tigerTagAuthoringPreview = null;
    document.getElementById('tigertag-preview').style.display = 'none';
    document.getElementById('tigertag-form').style.display = '';
    setTigerTagAuthoringMessage('Fields changed after this point require a new server preview.');
    updateTigerTagAuthoringGate();
}

function waitForTigerTagEvent(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function resolveTigerTagOperation(initialResult, context, action) {
    if (initialResult?.ok === true) return initialResult;
    if (initialResult?.code !== 'timeout_in_progress') {
        return requireOpenRfidResult(initialResult, 'TigerTag ' + action + ' failed');
    }
    const operationId = String(initialResult.operation_id || '');
    if (!/^[0-9a-f]{32}$/i.test(operationId)) {
        throw new Error('Timed-out operation did not return a valid operation ID; do not retry');
    }

    tigerTagUncertainOperations.set(context.channel, {
        operationId,
        action,
        uid: context.uid,
    });
    setTigerTagOperationMessage(
        'Operation ' + operationId + ' is still running. Polling its status; it will not be retried.',
        ''
    );
    updateTigerTagAuthoringGate();

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (tigerTagAuthoringContext !== context || !currentTigerTagAuthoringChannel(context)) {
            throw new Error('Target changed while operation ' + operationId + ' was running; do not retry');
        }
        let status;
        try {
            status = await openRfidRequest('openrfid/operation_status', {
                operation_id: operationId,
            });
        } catch (error) {
            throw new Error(
                'Could not query operation ' + operationId + ': '
                + openRfidResultError(error, error.message) + '. Do not retry until it is verified.'
            );
        }
        if (!status?.ok) {
            throw new Error(
                openRfidResultError(status, 'Operation status unavailable')
                + '. Operation ' + operationId + ' must not be retried.'
            );
        }
        if (status.operation_id !== operationId) {
            throw new Error('OpenRFID returned status for a different operation; do not retry');
        }
        if (status.completed === true) {
            if (!status.result || typeof status.result !== 'object') {
                throw new Error('Operation ' + operationId + ' completed without a terminal result');
            }
            if (status.result.ok !== true) {
                tigerTagUncertainOperations.delete(context.channel);
            }
            return status.result;
        }
        if (status.operation_state !== 'queued' && status.operation_state !== 'running') {
            throw new Error('Operation ' + operationId + ' has unknown state ' + status.operation_state);
        }
        setTigerTagOperationMessage(
            'Operation ' + operationId + ' is ' + status.operation_state
            + '; waiting without retrying...'
        );
        await waitForTigerTagEvent(500);
    }
    throw new Error(
        'Operation ' + operationId
        + ' is still unresolved. Do not retry until its status and a fresh scan are verified.'
    );
}

function requireVerifiedTigerTagMutation(result, context, action) {
    requireOpenRfidResult(result, 'TigerTag ' + action + ' failed');
    const expectedCode = action === 'write' ? 'written' : 'cleared';
    if (result.code !== expectedCode || result.verified !== true
            || result.start_page !== 4 || result.end_page !== 23
            || result.bytes_written !== 80) {
        throw new Error('OpenRFID did not return a complete verified ' + action + ' result');
    }
    if (TigerTagAuthoring.normalizeUid(result.uid) !== context.uid) {
        throw new Error('Physical ' + action + ' result belongs to a different UID');
    }
    return result;
}

async function refreshTigerTagGate(context) {
    const api = await loadOpenRfidChannels();
    if (!api) throw new Error('OpenRFID authoring API is unavailable');
    if (tigerTagAuthoringContext !== context || !currentTigerTagAuthoringChannel(context)) {
        throw new Error('The target tag changed');
    }
    const gate = updateTigerTagAuthoringGate();
    if (!gate?.ok) throw new Error(gate?.reasons?.join(' ') || 'TigerTag writing is blocked');
    return gate;
}

async function forceTigerTagRescanAndVerify(context, spec, action) {
    const slot = context.channel;
    invalidateOpenRfidSlot(slot);
    context.generation = openRfidSlotGenerations[slot];
    rebuildFromCache();
    const generation = context.generation;
    requireOpenRfidResult(
        await openRfidRequest('openrfid/scan_slot', { slot }),
        'Could not start the mandatory verification scan'
    );

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (openRfidSlotGenerations[slot] !== generation) {
            throw new Error('Tag presence changed during the verification scan');
        }
        const channel = currentTigerTagAuthoringChannel(context);
        if (!channel) throw new Error('The expected UID is no longer present');
        const scan = openRfidScans.get(slot);
        if (scan?._presenceGeneration === generation) {
            if (TigerTagAuthoring.normalizeUid(scan.uid) !== context.uid) {
                throw new Error('Verification scan returned a different UID');
            }
            if (action === 'clear') {
                if (scan.event === 'tag_parse_error' && !channel.decoded) {
                    return { channel, generation };
                }
                if (scan.event === 'tag_read') {
                    throw new Error('Cleared tag still contains a decodable payload');
                }
            } else {
                if (scan.event === 'tag_parse_error') {
                    throw new Error('Written TigerTag could not be decoded on the fresh scan');
                }
                if (scan.event === 'tag_read' && channel.decoded) {
                    const verification = TigerTagAuthoring.verifyRescan(channel, spec);
                    if (!verification.ok) {
                        throw new Error('Fresh readback mismatch: ' + verification.errors.join(', '));
                    }
                    return { channel, generation };
                }
            }
        }
        await waitForTigerTagEvent(250);
    }
    throw new Error('Timed out waiting for a fresh same-UID verification scan');
}

async function confirmTigerTagWrite() {
    const context = tigerTagAuthoringContext;
    const preview = tigerTagAuthoringPreview;
    if (!context || !preview || preview.context !== context
            || preview.uid !== context.uid || preview.generation !== context.generation) {
        setTigerTagOperationMessage('Preview is stale; return to the editor and encode it again.', 'error');
        return;
    }

    setTigerTagAuthoringBusy(true);
    try {
        await refreshTigerTagGate(context);
        if (preview.allowUnrecognized !== tigerTagInitializationOverride()
                || preview.allowLegacyMigration !== tigerTagLegacyMigrationOverride()) {
            throw new Error('Safety confirmation changed after preview; encode a new preview');
        }
        const mode = preview.allowLegacyMigration
            ? 'MIGRATE legacy_openrfid_v1 to Maker'
            : preview.allowUnrecognized
                ? 'INITIALIZE an unrecognized NTAG as Maker'
                : 'WRITE TigerTag Maker';
        const confirmed = window.confirm(
            mode + '\n\nExtruder ' + (context.channel + 1)
            + '\nUID ' + context.uid.match(/.{2}/g).join(':')
            + '\nPages 4-23, 80 bytes\n\n'
            + 'The operation will be accepted only for this UID and success requires a fresh readback.'
        );
        if (!confirmed) return;

        setTigerTagOperationMessage('Writing pages 4-23 and verifying physical readback...');
        const request = TigerTagAuthoring.writePayloadRequest(
            context.channel,
            context.uid,
            preview.encoded.data_hex,
            preview.allowUnrecognized,
            preview.allowLegacyMigration
        );
        request.timeout = 20;
        let result = await openRfidRequest('openrfid/write_tag', request);
        result = await resolveTigerTagOperation(result, context, 'write');
        if (result?.ok === true) {
            tigerTagUncertainOperations.set(context.channel, {
                operationId: String(result.operation_id || 'completed-write'),
                action: 'write',
                uid: context.uid,
            });
        }
        requireVerifiedTigerTagMutation(result, context, 'write');
        await forceTigerTagRescanAndVerify(context, preview.spec, 'write');
        tigerTagUncertainOperations.delete(context.channel);
        tigerTagAuthoringPreview = null;
        setTigerTagOperationMessage(
            'Write completed and every field was verified by a fresh same-UID scan.',
            'success'
        );
        showStatus('TigerTag written and verified on extruder ' + (context.channel + 1), 'success');
        updateTigerTagSourceButtons();
        updateTigerTagAuthoringGate();
    } catch (error) {
        setTigerTagOperationMessage(
            'Write not confirmed: ' + openRfidResultError(error, error.message),
            'error'
        );
        showStatus('TigerTag write was not verified', 'error');
    } finally {
        if (tigerTagAuthoringContext === context) setTigerTagAuthoringBusy(false);
    }
}

async function clearTigerTag() {
    const context = tigerTagAuthoringContext;
    if (!context || !currentTigerTagAuthoringChannel(context)) {
        setTigerTagAuthoringMessage('The target tag changed', 'error');
        return;
    }
    setTigerTagAuthoringBusy(true);
    try {
        await refreshTigerTagGate(context);
        const allowUnrecognized = tigerTagInitializationOverride();
        const allowLegacyMigration = tigerTagLegacyMigrationOverride();
        const mode = allowLegacyMigration
            ? 'CLEAR the exact legacy_openrfid_v1 payload'
            : allowUnrecognized
                ? 'CLEAR this unrecognized NTAG payload'
                : 'CLEAR this TigerTag Maker payload';
        const confirmed = window.confirm(
            mode + '\n\nExtruder ' + (context.channel + 1)
            + '\nUID ' + context.uid.match(/.{2}/g).join(':')
            + '\nPages 4-23 will be zeroed. Other pages are untouched.\n\n'
            + 'Success requires a fresh same-UID tag_parse_error readback.'
        );
        if (!confirmed) return;

        setTigerTagAuthoringMessage('Clearing pages 4-23 and verifying...', '');
        const request = TigerTagAuthoring.clearRequest(
            context.channel,
            context.uid,
            allowUnrecognized,
            allowLegacyMigration
        );
        request.timeout = 20;
        let result = await openRfidRequest('openrfid/clear_tag', request);
        result = await resolveTigerTagOperation(result, context, 'clear');
        if (result?.ok === true) {
            tigerTagUncertainOperations.set(context.channel, {
                operationId: String(result.operation_id || 'completed-clear'),
                action: 'clear',
                uid: context.uid,
            });
        }
        requireVerifiedTigerTagMutation(result, context, 'clear');
        await forceTigerTagRescanAndVerify(context, null, 'clear');
        tigerTagUncertainOperations.delete(context.channel);
        tigerTagAuthoringPreview = null;
        setTigerTagAuthoringMessage(
            'Clear completed and a fresh scan confirmed the same UID has no decodable payload.',
            'success'
        );
        showStatus('TigerTag data cleared and verified on extruder ' + (context.channel + 1), 'success');
        updateTigerTagSourceButtons();
        updateTigerTagAuthoringGate();
    } catch (error) {
        setTigerTagAuthoringMessage(
            'Clear not confirmed: ' + openRfidResultError(error, error.message),
            'error'
        );
        showStatus('TigerTag clear was not verified', 'error');
    } finally {
        if (tigerTagAuthoringContext === context) setTigerTagAuthoringBusy(false);
    }
}

async function refreshSpoolWeights() {
    if (!spoolmanActive || !wsReady) return;
    const activeIds = [...new Set(channelsData.map(ch => ch.spool_id).filter(id => id != null))];
    if (activeIds.length === 0) return;
    await Promise.all(activeIds.map(async id => {
        const spool = await fetchSpoolmanSpool(id);
        if (spool) spoolmanSpools.set(id, spool);
    }));
    rebuildFromCache();
}

function scheduleSpoolRefresh() {
    const hasActiveSpool = channelsData.some(ch => ch.spool_id != null);
    const delay = hasActiveSpool ? SPOOL_REFRESH_ACTIVE_MS : SPOOL_REFRESH_IDLE_MS;
    spoolRefreshTimer = setTimeout(async () => {
        await refreshSpoolWeights();
        scheduleSpoolRefresh();
    }, delay);
}

function mergeStatus(status) {
    if (status.filament_detect) {
        const beforeInfo = cachedStatus.filament_detect.info || [{}, {}, {}, {}];
        const beforeState = cachedStatus.filament_detect.state || [0, 0, 0, 0];
        const beforeUids = [0, 1, 2, 3].map(slot =>
            RfidPort.normalizeUid(beforeInfo[slot]?.CARD_UID));
        const beforeStates = [0, 1, 2, 3].map(slot => beforeState[slot]);

        Object.assign(cachedStatus.filament_detect, status.filament_detect);

        const afterInfo = cachedStatus.filament_detect.info || [{}, {}, {}, {}];
        const afterState = cachedStatus.filament_detect.state || [0, 0, 0, 0];
        for (let slot = 0; slot < 4; slot++) {
            const afterUid = RfidPort.normalizeUid(afterInfo[slot]?.CARD_UID);
            const detectingStarted = afterState[slot] === FD_STATE_DETECTING
                && beforeStates[slot] !== FD_STATE_DETECTING;
            if (beforeUids[slot] !== afterUid || detectingStarted) {
                invalidateOpenRfidSlot(slot);
            }
        }
    }
    if (status.print_task_config) Object.assign(cachedStatus.print_task_config, status.print_task_config);
}

function rebuildFromCache() {
    const fd  = cachedStatus.filament_detect;
    const ptc = cachedStatus.print_task_config;
    const detectInfo = fd.info || [{}, {}, {}, {}];
    const fdState    = fd.state || [0, 0, 0, 0];

    channelsData = [];
    for (let i = 0; i < 4; i++) {
        channelsData.push(parseChannelInfo(i, detectInfo[i] || {}, fdState[i] || 0, ptc));
    }
    renderChannels();
}

// ── Manual refresh (runs FILAMENT_DT gcodes) ──────────────────────────────

async function refreshAllChannels() {
    if (refreshing) return;
    if (!wsReady) { showStatus('Waiting for connection…', 'info'); return; }

    refreshing = true;
    const btn = document.getElementById('refresh-all');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Reading…'; }

    try {
        for (let i = 0; i < 4; i++) invalidateOpenRfidSlot(i);
        const gcodes = [];
        for (let i = 0; i < 4; i++) gcodes.push(`FILAMENT_DT_CLEAR CHANNEL=${i}`);
        for (let i = 0; i < 4; i++) gcodes.push(`FILAMENT_DT_UPDATE CHANNEL=${i}`);
        await sendGcode(gcodes.join('\n'));
    } catch (err) {
        showStatus(`Refresh failed: ${err.message}`, 'error');
    } finally {
        refreshing = false;
        if (btn) { btn.disabled = !wsReady; btn.textContent = 'Read spool tags'; }
    }
}

async function refreshSingleChannel(channel) {
    if (!wsReady) { showStatus('Waiting for connection…', 'info'); return; }
    try {
        invalidateOpenRfidSlot(channel);
        await sendGcode(`FILAMENT_DT_CLEAR CHANNEL=${channel}\nFILAMENT_DT_UPDATE CHANNEL=${channel}`);
    } catch (err) {
        showStatus(`Refresh failed: ${err.message}`, 'error');
    }
}

// ── Channel parsing ───────────────────────────────────────────────────────

function parseChannelInfo(i, fd, fdState, ptc) {
    // CARD_UID always from filament_detect
    const uid = fd.CARD_UID || [];
    const hasUid = uid.length > 0;
    const cardType = fd.CARD_TYPE || null;
    const tagStatus = fd.TAG_STATUS || null;
    const fdMainType = fd.MAIN_TYPE && fd.MAIN_TYPE !== 'NONE' ? fd.MAIN_TYPE : null;
    const present = fdState === FD_STATE_DETECTING || hasUid;
    const uidHex = RfidPort.normalizeUid(uid);
    const cachedOpenRfidScan = openRfidScans.get(i) || null;
    const scanUid = RfidPort.normalizeUid(cachedOpenRfidScan?.uid);
    const scanMatches = !!(uidHex && scanUid && uidHex === scanUid
        && cachedOpenRfidScan?._presenceGeneration === openRfidSlotGenerations[i]
        && cachedOpenRfidScan?.event !== 'tag_not_present');
    const decoded = scanMatches && cachedOpenRfidScan?.filament
        ? RfidPort.normalizeDecoded(cachedOpenRfidScan.filament, fd.TAG_FORMAT)
        : null;
    const tagFormat = decoded?.tagFormat || (hasUid ? (fd.TAG_FORMAT || null) : null);
    const hardwareType = RfidPort.hardwareFrom(
        scanMatches ? cachedOpenRfidScan?.tag_type : null,
        cardType
    );

    // official flag and existence from print_task_config
    const isOfficial = !!(ptc.filament_official && ptc.filament_official[i]);
    const filamentExists = !!(ptc.filament_exist && ptc.filament_exist[i]);

    // Basic info from print_task_config
    const ptcType       = ptc.filament_type       && ptc.filament_type[i];
    const ptcVendor     = ptc.filament_vendor      && ptc.filament_vendor[i];
    const ptcSubType    = ptc.filament_sub_type    && ptc.filament_sub_type[i];
    const ptcColorMulti = ptc.filament_color_multi && ptc.filament_color_multi[i];
    const ptcColorRgba  = ptc.filament_color_rgba  && ptc.filament_color_rgba[i];
    const spoolId       = ptc.filament_spool_id?.[i] > 0
        ? ptc.filament_spool_id[i] : null;

    const type    = ptcType    && ptcType    !== 'NONE' ? ptcType    : null;
    const vendor  = ptcVendor  && ptcVendor  !== 'NONE' ? ptcVendor  : null;
    const subtype = (ptcSubType == null || ptcSubType === 'NONE') ? null : ptcSubType;

    // Color from print_task_config
    let firstColor = null, alpha = 0xFF, additionalColors = [];
    if (ptcColorMulti && ptcColorMulti.nums > 0 && ptcColorMulti.colors) {
        const cols = ptcColorMulti.colors.slice(0, ptcColorMulti.nums);
        if (cols[0]) firstColor = cols[0].toUpperCase();
        alpha = ptcColorMulti.alpha !== undefined ? ptcColorMulti.alpha : 0xFF;
        additionalColors = cols.slice(1).map(c => c ? c.toUpperCase() : null).filter(Boolean);
    } else if (ptcColorRgba && ptcColorRgba.length >= 6) {
        firstColor = ptcColorRgba.substring(0, 6).toUpperCase();
        alpha = ptcColorRgba.length >= 8 ? parseInt(ptcColorRgba.substring(6, 8), 16) : 0xFF;
    }

    const spoolInfo = spoolId != null ? (spoolmanSpools.get(spoolId) ?? null) : null;
    const remainingWeight = spoolInfo != null && spoolInfo.remaining_weight != null
        ? Math.round(spoolInfo.remaining_weight) : null;

    // A bare UID card (third-party / unprogrammed) carries no filament
    // metadata, so the tag reports sentinel defaults — RGB_1 reads back as
    // FFFFFF (white) and the temps/diameter/density come back as zeros. Only
    // the Card UID is trustworthy in that case, so suppress the derived fields
    // unless the tag actually carries filament data (a material type or vendor).
    const rfidVendor  = fd.VENDOR && fd.VENDOR !== 'NONE' ? fd.VENDOR : null;
    const rfidHasData = !!(fdMainType || rfidVendor);
    const rfidData = hasUid ? {
        type:     fdMainType,
        sub_type: fd.SUB_TYPE && fd.SUB_TYPE !== 'NONE' && fd.SUB_TYPE !== 'Basic' ? fd.SUB_TYPE : null,
        vendor:   rfidVendor,
        color:    rfidHasData && fd.RGB_1 != null ? (fd.RGB_1 & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase() : null,
        min_temp: rfidHasData ? (fd.HOTEND_MIN_TEMP || null) : null,
        max_temp: rfidHasData ? (fd.HOTEND_MAX_TEMP || null) : null,
        bed_temp: rfidHasData ? (fd.BED_TEMP        || null) : null,
        diameter: rfidHasData && fd.DIAMETER ? fd.DIAMETER / 100.0 : null,
        density:  rfidHasData ? (fd.DENSITY         || null) : null,
    } : null;

    const cmpStr = (a, b) => !!(a && b && a.toLowerCase() !== b.toLowerCase());

    let mismatch = false;
    if (rfidData && spoolInfo) {
        const sm = spoolInfo.filament || {};
        const smColor = sm.color_hex ? sm.color_hex.replace('#', '').toUpperCase() : null;
        if (cmpStr(rfidData.type,   sm.material))     mismatch = true;
        if (cmpStr(rfidData.vendor, sm.vendor?.name)) mismatch = true;
        if (rfidData.color && smColor && rfidData.color !== smColor) mismatch = true;
    } else if (rfidData) {
        if (cmpStr(rfidData.type,     type))    mismatch = true;
        if (cmpStr(rfidData.vendor,   vendor))  mismatch = true;
        if (cmpStr(rfidData.sub_type, subtype)) mismatch = true;
        if (rfidData.color && firstColor && rfidData.color !== firstColor) mismatch = true;
    }

    const ptcSources = [];
    if (isOfficial) ptcSources.push('official');
    if (spoolId > 0) ptcSources.push('spoolman');
    if (ptcSources.length === 0) {
        if (type)                ptcSources.push('user');
        else if (filamentExists) ptcSources.push('unknown');
    }

    return {
        channel: i,
        present,
        filament_exists: filamentExists,
        official: isOfficial,
        uid,
        card_type: cardType,
        uid_hex: uidHex,
        tag_format: tagFormat,
        physical: {
            state: decoded ? 'read' : (hasUid ? 'unrecognized' : 'not_present'),
            uidHex,
            hardwareType,
            reader: scanMatches ? cachedOpenRfidScan?.reader || null : null,
            scannedAt: scanMatches ? cachedOpenRfidScan?.ts || null : null,
        },
        decoded,
        openRfidCapabilities: openRfidChannelCapabilities.get(i) || null,
        capabilities: {
            scan: openRfidAvailable,
            write: openRfidAvailable && openRfidWriteEnabled,
            clear: openRfidAvailable && openRfidWriteEnabled,
        },
        spool_id: spoolId,
        rfid_data: rfidData,
        mismatch,
        ptc_sources: ptcSources,
        empty: hasUid && !fdMainType && tagStatus !== 'error',
        malformed: hasUid && !fdMainType && tagStatus === 'error',
        filament: {
            type,
            brand: vendor,
            subtype,
            first_color: firstColor,
            alpha,
            additional_colors: additionalColors,
            remaining_weight: remainingWeight,
            // Extended fields only available via RFID
            diameter:     isOfficial && fd.DIAMETER         ? fd.DIAMETER / 100.0     : null,
            density:      isOfficial                        ? fd.DENSITY    || null   : null,
            min_temp:     isOfficial                        ? fd.HOTEND_MIN_TEMP || null : null,
            max_temp:     isOfficial                        ? fd.HOTEND_MAX_TEMP || null : null,
            bed_min_temp: isOfficial                        ? fd.BED_MIN_TEMP    || null : null,
            bed_max_temp: isOfficial                        ? fd.BED_MAX_TEMP    || null : null,
            weight:       isOfficial                        ? fd.WEIGHT     || null   : null,
        },
    };
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderChannels() {
    const grid = document.getElementById('channels-grid');
    grid.innerHTML = '';
    channelsData.forEach(ch => grid.appendChild(createChannelCard(ch)));
}

function createChannelCard(channel) {
    const card = document.createElement('div');
    card.className = 'channel-card';
    card.dataset.channel = channel.channel;

    const displayCh = channel.channel + 1;
    const { present, filament_exists: filamentExists, official: isOfficial,
            empty: isEmpty, malformed: isMalformed, filament, card_type, uid,
            spool_id: spoolId, mismatch, ptc_sources: ptcSources } = channel;
    const hasUid = uid.length > 0;
    const hasPtcInfo = !!filament.type;
    const showBody = present || filamentExists || hasPtcInfo || spoolmanActive;

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'channel-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'channel-title';
    titleEl.textContent = `Extruder ${displayCh}`;
    header.appendChild(titleEl);

    const badgesDiv = document.createElement('div');
    badgesDiv.className = 'header-badges';

    // Slot 1: [Empty] when nothing else to show
    if (ptcSources.length === 0 && !hasUid && !present) {
        const b = document.createElement('span');
        b.className = 'tag-type-badge';
        b.textContent = 'Empty';
        badgesDiv.appendChild(b);
    }

    // Slot 2: config source — Official / Spoolman / User / Unknown
    for (const src of ptcSources) {
        const b = document.createElement('span');
        if (src === 'official') {
            b.className = 'tag-type-badge official';
            b.textContent = 'Official';
        } else if (src === 'spoolman') {
            b.className = 'tag-type-badge spoolman';
            b.textContent = 'Spoolman';
            b.addEventListener('mouseenter', () => {
                const spool = spoolId != null ? spoolmanSpools.get(spoolId) : null;
                if (!spool) return;
                const rows = [{ label: 'ID', value: `#${spool.id}` }];
                if (spool.filament.name)            rows.push({ label: 'Name',      value: spool.filament.name });
                if (spool.filament.vendor?.name)    rows.push({ label: 'Brand',     value: spool.filament.vendor.name });
                if (spool.filament.material)        rows.push({ label: 'Material',  value: spool.filament.material });
                const smHexes = spool.filament.multi_color_hexes
                    ? spool.filament.multi_color_hexes.split(',').map(c => c.trim()).filter(Boolean)
                    : (spool.filament.color_hex ? [spool.filament.color_hex] : null);
                if (smHexes && smHexes.length > 0) {
                    const html = smHexes.map(c =>
                        `<span class="color-swatch" style="background:#${escHtml(c)}" title="#${escHtml(c)}"></span><span>#${escHtml(c)}</span>`
                    ).join(' ');
                    rows.push({ label: 'Color', html });
                }
                if (spool.remaining_weight != null) rows.push({ label: 'Remaining', value: `${Math.round(spool.remaining_weight)} g` });
                if (spool.filament.weight  != null) rows.push({ label: 'Total',     value: `${spool.filament.weight} g` });
                showPopover(b, rows);
            });
            b.addEventListener('mouseleave', hidePopover);
        } else if (src === 'unknown') {
            b.className = 'tag-type-badge unknown';
            b.textContent = 'Unknown';
        } else {
            b.className = 'tag-type-badge user';
            b.textContent = 'User';
        }
        badgesDiv.appendChild(b);
    }

    // Slot 3: physical presence — RFID (tag read) or Detecting (in progress)
    if (hasUid) {
        const b = document.createElement('span');
        b.className = 'tag-type-badge format';
        b.textContent = channel.tag_format
            ? RfidPort.formatLabel(channel.tag_format)
            : 'Unrecognized';
        b.addEventListener('click', e => {
            e.stopPropagation();
            openTagDetails(channel.channel);
        });
        if (channel.rfid_data) {
            b.addEventListener('mouseenter', () => {
                const rfid = channel.rfid_data;
                const rows = [];
                if (rfid.type     != null) rows.push({ label: 'Type',    value: rfid.type });
                if (rfid.sub_type != null) rows.push({ label: 'Subtype', value: rfid.sub_type });
                if (rfid.vendor   != null) rows.push({ label: 'Vendor',  value: rfid.vendor });
                if (rfid.color    != null) rows.push({ label: 'Color',   value: `#${rfid.color}` });
                if (rfid.bed_temp != null) rows.push({ label: 'Bed',     value: `${rfid.bed_temp} °C` });
                if (rfid.min_temp != null) rows.push({ label: 'Hotend',  value: `${rfid.min_temp}–${rfid.max_temp ?? '?'} °C` });
                rows.push({ label: 'UID', value: uid.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':') });
                showPopover(b, rows);
            });
            b.addEventListener('mouseleave', hidePopover);
        }
        badgesDiv.appendChild(b);
        if (channel.physical?.hardwareType) {
            const hardwareBadge = document.createElement('span');
            hardwareBadge.className = 'tag-type-badge hardware';
            hardwareBadge.textContent = RfidPort.hardwareLabel(channel.physical.hardwareType);
            hardwareBadge.addEventListener('click', e => {
                e.stopPropagation();
                openTagDetails(channel.channel);
            });
            badgesDiv.appendChild(hardwareBadge);
        }
    } else if (present) {
        const b = document.createElement('span');
        b.className = 'tag-type-badge detecting';
        b.textContent = 'Detecting';
        badgesDiv.appendChild(b);
    }

    const mBadge = document.createElement('span');
    mBadge.className = 'tag-type-badge' + (mismatch ? ' mismatch' : '');
    mBadge.textContent = '⚠ Mismatch';
    mBadge.style.display = mismatch ? '' : 'none';
    mBadge.addEventListener('click', e => { e.stopPropagation(); openMismatchModal(channel.channel); });
    badgesDiv.appendChild(mBadge);

    header.appendChild(badgesDiv);
    card.appendChild(header);

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'channel-body';

    if (!showBody) {
        const empty = document.createElement('div');
        empty.className = 'channel-empty';
        empty.textContent = 'No spool detected';
        body.appendChild(empty);
    } else {
        const grid = document.createElement('div');
        grid.className = 'field-grid';

        const addRow = (label, html) => {
            const lEl = document.createElement('span');
            lEl.className = 'field-label';
            lEl.textContent = label;
            const vEl = document.createElement('span');
            vEl.className = 'field-value';
            vEl.innerHTML = html;
            grid.appendChild(lEl);
            grid.appendChild(vEl);
        };

        const na = '<span class="field-unknown">N/A</span>';

        if (filament.type) {
            const subtypePart = filament.subtype ? ` ${filament.subtype}` : '';
            const profileName = `${filament.brand || 'Generic'} ${filament.type}${subtypePart}`.trim();
            addRow('Material',
                `<span class="orca-profile-name">${escHtml(profileName)}</span>` +
                `<button type="button" class="copy-name-btn" aria-label="Copy name">⧉</button>`);
            grid.lastElementChild.querySelector('.copy-name-btn').addEventListener('click', () => {
                copyToClipboard(profileName)
                    .then(() => showStatus('Filament name copied', 'success'))
                    .catch(() => showStatus('Failed to copy filament name', 'error'));
            });
        } else {
            addRow('Material', na);
        }

        if (spoolmanActive) {
            let spoolIdHtml = na;
            if (spoolId != null) {
                spoolIdHtml = `#${spoolId}`;
                if (spoolmanUrl) spoolIdHtml += ` <a href="${spoolmanUrl}/spool/show/${spoolId}" target="_blank" rel="noopener">↗</a>`;
            }
            addRow('Spool ID', spoolIdHtml);
            addRow('Remaining', filament.remaining_weight != null
                ? `<span class="spool-remaining">${filament.remaining_weight} g</span>`
                : na);
        }

        if (isMalformed) {
            addRow('Status', '<span class="tag-warning">Unrecognized RFID data</span>');
        }

        if (filament.first_color) {
            const alphaStr = filament.alpha < 0xFF ? ` ${(filament.alpha / 255 * 100).toFixed(0)}%` : '';
            const colorHtml = [filament.first_color, ...filament.additional_colors].map(h =>
                `<span class="color-swatch" style="background:#${h}" title="#${h}"></span><span>#${h}</span>`
            ).join(' ') + alphaStr;
            addRow('Color', colorHtml);
        } else {
            addRow('Color', na);
        }

        const uidHex = hasUid
            ? uid.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
            : null;
        const uidDisplay = uidHex
            ? `<span class="uid-value">${uidHex}</span>${card_type ? ` (${card_type})` : ''}`
            : na;
        addRow('Card UID', uidDisplay);

        body.appendChild(grid);
    }
    card.appendChild(body);

    // ── Actions ──
    const actions = document.createElement('div');
    actions.className = 'channel-actions';

    const mkBtn = (text, extra, handler) => {
        const btn = document.createElement('button');
        btn.className = 'channel-action-btn' + (extra ? ' ' + extra : '');
        btn.textContent = text;
        btn.addEventListener('click', handler);
        return btn;
    };

    actions.appendChild(mkBtn('↻ Refresh', '', () => refreshSingleChannel(channel.channel)));
    actions.appendChild(mkBtn('✎ User', '', () => openOverwriteModal(channel.channel)));
    if (hasUid) actions.appendChild(mkBtn('Details', '', () => openTagDetails(channel.channel)));
    if (hasUid && openRfidAvailable) {
        const authorButton = mkBtn('TigerTag', '', () => void openTigerTagEditor(channel.channel));
        const writer = channel.openRfidCapabilities?.tigertag_write;
        const globalCapabilities = openRfidApi?.capabilities || {};
        const reasons = [];
        if (channel.physical?.hardwareType !== 'ultralight') {
            reasons.push('Only Ultralight / NTAG hardware is writable');
        }
        if (globalCapabilities.tigertag_options !== true
                || globalCapabilities.tigertag_encode !== true
                || globalCapabilities.tigertag_write !== true
                || globalCapabilities.expected_uid_required !== true
                || globalCapabilities.expected_format !== 'tigertag'
                || globalCapabilities.print_state_guard !== true) {
            reasons.push('TigerTag authoring is disabled by OpenRFID');
        }
        if (!writer || writer.supported !== true) {
            reasons.push(writer?.error || 'This reader does not support guarded TigerTag writes');
        }
        if (openRfidApi?.write_allowed === false) {
            reasons.push(openRfidApi.write_block?.error || 'The printer write gate is closed');
        }
        if (TigerTagAuthoring.protectedTigerTag(channel)) {
            reasons.push('TigerTag+ is read-only');
        }
        if (TigerTagAuthoring.migratableLegacyTag(channel)
                && (openRfidApi?.allow_legacy_migration_write !== true
                    || writer?.allow_legacy_migration_supported !== true)) {
            reasons.push('legacy_openrfid_v1 migration is disabled');
        }
        if (channel.tag_format !== 'tigertag'
                && openRfidApi?.allow_unrecognized_write !== true) {
            reasons.push('Blank/unrecognized NTAG initialization is disabled');
        }
        const uncertain = tigerTagUncertainOperations.get(channel.channel);
        if (uncertain) reasons.push('Operation ' + uncertain.operationId + ' is unresolved');
        authorButton.disabled = reasons.length > 0;
        authorButton.title = reasons.join('. ');
        actions.appendChild(authorButton);
    }
    actions.appendChild(mkBtn('Reset', '', () => resetChannel(channel.channel)));
    if (spoolmanActive) {
        actions.appendChild(mkBtn('⊕ Spool', '', () => openSpoolPicker(channel.channel)));
        if (channel.spool_id != null && channel.decoded) {
            actions.appendChild(mkBtn('Sync tag', '', () => openSpoolmanMetadataSync(channel.channel)));
        }
    }

    card.appendChild(actions);
    return card;
}

// ── Info popover ──────────────────────────────────────────────────────────

const TAG_FIELD_LABELS = {
    message: 'Tag message',
    manufacturer: 'Manufacturer',
    type: 'Material',
    material_name: 'TigerTag SDK material label',
    modifiers: 'Aspects / variant',
    colors: 'Colors (ARGB)',
    colors_rgba_hex: 'Colors (RGBA)',
    diameter_mm: 'Diameter',
    weight_grams: 'Initial quantity',
    available_weight_grams: 'Available quantity',
    hotend_min_temp_c: 'Nozzle minimum',
    hotend_max_temp_c: 'Nozzle maximum',
    bed_temp_min_c: 'Bed minimum',
    bed_temp_c: 'Bed temperature / minimum',
    bed_temp_max_c: 'Bed maximum',
    drying_temp_c: 'Drying temperature',
    drying_time_hours: 'Drying duration',
    manufacturing_date: 'Manufacturing date',
    td: 'Transmission distance',
    td_mm: 'Transmission distance',
    unique_id: 'Content ID',
    source_processor: 'Processor',
    rgb: 'Primary RGB',
    alpha: 'Primary alpha',
    rgba: 'Primary RGBA',
    colors_rgba: 'Colors (RGBA integers)',
};

function humanizeTagField(key) {
    if (TAG_FIELD_LABELS[key]) return TAG_FIELD_LABELS[key];
    return String(key).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatTagFieldValue(key, value) {
    if (Array.isArray(value)) return value.length ? value.join(', ') : '[]';
    if (value && typeof value === 'object') return JSON.stringify(value);
    if (value === null) return 'null';
    if (value === '') return '(empty)';
    if (key === 'diameter_mm' || key === 'td' || key === 'td_mm') return `${value} mm`;
    if (key.endsWith('_temp_c')) return `${value} °C`;
    if (key === 'drying_time_hours') return `${value} h`;
    if (key.endsWith('_grams')) return `${value} g`;
    if (key === 'rgb') return `#${Number(value).toString(16).padStart(6, '0').toUpperCase()}`;
    if (key === 'rgba') return `0x${Number(value).toString(16).padStart(8, '0').toUpperCase()}`;
    return String(value);
}

function appendDetailsSection(container, title, rows) {
    if (!rows.length) return;
    const heading = document.createElement('h3');
    heading.className = 'tag-details-section-title';
    heading.textContent = title;
    container.appendChild(heading);
    const table = document.createElement('div');
    table.className = 'tag-details-table';
    for (const row of rows) {
        const label = document.createElement('span');
        label.className = 'tag-details-label';
        label.textContent = row.label;
        const value = document.createElement('span');
        value.className = 'tag-details-value';
        value.textContent = row.value;
        table.append(label, value);
    }
    container.appendChild(table);
}

function openTagDetails(channelNumber) {
    const channel = channelsData.find(item => item.channel === channelNumber);
    if (!channel) return;
    document.getElementById('tag-details-title').textContent =
        `RFID Tag - Extruder ${channelNumber + 1}`;
    const content = document.getElementById('tag-details-content');
    content.innerHTML = '';

    const physical = channel.physical || {};
    const physicalRows = [
        { label: 'Card UID', value: physical.uidHex || 'Unknown' },
        { label: 'Hardware', value: RfidPort.hardwareLabel(physical.hardwareType) },
        { label: 'Payload format', value: RfidPort.formatLabel(channel.tag_format) },
    ];
    if (physical.reader) physicalRows.push({ label: 'Reader', value: physical.reader });
    if (physical.scannedAt) {
        physicalRows.push({
            label: 'Scanned',
            value: new Date(Number(physical.scannedAt) * 1000).toLocaleString(),
        });
    }
    appendDetailsSection(content, 'Physical tag', physicalRows);

    const decoded = channel.decoded;
    if (decoded) {
        const fields = decoded.fields || {};
        const present = Array.isArray(decoded.presentFields)
            ? decoded.presentFields
            : Object.keys(fields);
        const seen = new Set();
        const preferred = [
            'message', 'manufacturer', 'type', 'material_name', 'modifiers', 'colors_rgba_hex',
            'diameter_mm', 'weight_grams', 'available_weight_grams',
            'hotend_min_temp_c', 'hotend_max_temp_c', 'bed_temp_min_c',
            'bed_temp_c', 'bed_temp_max_c', 'drying_temp_c',
            'drying_time_hours', 'manufacturing_date', 'td', 'td_mm',
            'unique_id', 'source_processor',
        ];
        const orderedKeys = preferred.concat(present.filter(key => !preferred.includes(key)));
        const decodedRows = [];
        for (const key of orderedKeys) {
            if (seen.has(key) || !present.includes(key) || !(key in fields)) continue;
            seen.add(key);
            decodedRows.push({
                label: humanizeTagField(key),
                value: formatTagFieldValue(key, fields[key]),
            });
        }
        appendDetailsSection(content, 'Decoded payload', decodedRows);

        const formatRows = Object.entries(decoded.formatData || {}).map(([key, value]) => ({
            label: humanizeTagField(key),
            value: formatTagFieldValue(key, value),
        }));
        appendDetailsSection(content, 'Format-specific data', formatRows);

        const authRows = Object.entries(decoded.authentication || {}).map(([key, value]) => ({
            label: humanizeTagField(key),
            value: formatTagFieldValue(key, value),
        }));
        appendDetailsSection(content, 'Authentication', authRows);
    } else {
        const note = document.createElement('p');
        note.className = 'tag-details-empty';
        note.textContent = 'The tag is present, but OpenRFID did not decode a supported payload.';
        content.appendChild(note);
    }

    openModal('tag-details-modal');
}

function showPopover(anchorEl, rows) {
    const popover = document.getElementById('info-popover');
    popover.innerHTML = rows.map(r =>
        `<div class="popover-row">` +
        `<span class="popover-label">${escHtml(r.label)}</span>` +
        `<span class="popover-value">${r.html !== undefined ? r.html : escHtml(r.value)}</span>` +
        `</div>`
    ).join('');

    popover.style.visibility = 'hidden';
    popover.style.display = 'block';

    const rect = anchorEl.getBoundingClientRect();
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    let top  = rect.bottom + 6;
    let left = rect.left;

    if (left + pw > window.innerWidth - 8)  left = window.innerWidth  - pw - 8;
    if (top  + ph > window.innerHeight - 8) top  = rect.top - ph - 6;

    popover.style.top  = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.visibility = '';
}

function hidePopover() {
    document.getElementById('info-popover').style.display = 'none';
}

// ── Spoolman picker ───────────────────────────────────────────────────────

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// navigator.clipboard requires a secure context, which this UI may not have
// when served over plain HTTP on the local network — fall back to the
// legacy execCommand approach in that case.
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy') ? resolve() : reject(new Error('execCommand failed'));
        } catch (err) {
            reject(err);
        } finally {
            textarea.remove();
        }
    });
}

async function openSpoolPicker(channel) {
    spoolPickerChannel = channel;
    document.getElementById('spoolman-modal-title').textContent = `Pick Spool — Extruder ${channel + 1}`;
    document.getElementById('spoolman-search').value = '';
    const list = document.getElementById('spoolman-list');
    list.innerHTML = '<div class="spoolman-loading"><span class="spinner"></span> Loading…</div>';
    openModal('spoolman-modal');

    const spools = await fetchSpoolmanAllSpools();
    spoolPickerSpools = spools;
    const ch = channelsData.find(c => c.channel === channel);
    spoolPickerCurrentId = ch ? ch.spool_id : null;
    spoolPickerContext = RfidPort.buildTagMatchContext(
        ch?.decoded,
        ch?.physical?.uidHex
    );
    renderGroupedSpoolList('');
}

function createGroupedSpoolItem(spool, suggestion) {
    const item = document.createElement('div');
    item.className = 'spoolman-item' + (spool.id === spoolPickerCurrentId ? ' active' : '');
    const filament = spool.filament || {};
    const name = filament.name || filament.material || 'Unknown';
    const vendor = filament.vendor?.name || '';
    const material = filament.material || '';
    const variant = RfidPort.decodeExtra(filament.extra?.variant);
    const variantText = Array.isArray(variant) ? variant.join(', ') : (variant || '');
    const meta = [vendor, material, variantText].filter(Boolean).join(' · ');
    const weight = spool.remaining_weight != null ? `${Math.round(spool.remaining_weight)} g` : '—';
    const rawColors = filament.multi_color_hexes
        ? filament.multi_color_hexes.split(',').map(value => value.trim()).filter(Boolean)
        : [filament.color_hex || 'CCCCCC'];
    const colors = rawColors.map(value => String(value).replace(/^#/, ''))
        .filter(value => /^[0-9A-F]{6}$/i.test(value));
    const swatchesHtml = (colors.length ? colors : ['CCCCCC'])
        .map(color => `<div class="spoolman-swatch" style="background:#${color.toUpperCase()}"></div>`)
        .join('');
    const reasons = suggestion?.reasons?.length
        ? `<div class="spoolman-match-reasons">Matches: ${escHtml(suggestion.reasons.join(', '))}</div>`
        : '';
    item.innerHTML =
        `<div class="spoolman-swatches">${swatchesHtml}</div>` +
        '<div class="spoolman-info">' +
            `<div class="spoolman-name">${escHtml(name)}</div>` +
            `<div class="spoolman-meta">${escHtml(meta)}</div>` +
            reasons +
        '</div>' +
        '<div class="spoolman-right">' +
            `<div class="spoolman-weight">${escHtml(weight)}</div>` +
            `<div class="spoolman-id">#${escHtml(spool.id)}</div>` +
        '</div>';
    item.addEventListener('click', () => pickSpool(spool.id));
    return item;
}

function appendSpoolPickerGroup(list, title, rows, suggestions = false) {
    if (!rows.length) return;
    const heading = document.createElement('div');
    heading.className = 'spoolman-group-heading';
    heading.textContent = `${title} (${rows.length})`;
    list.appendChild(heading);
    for (const row of rows) {
        const spool = suggestions ? row.spool : row;
        list.appendChild(createGroupedSpoolItem(spool, suggestions ? row : null));
    }
}

function renderGroupedSpoolList(filter) {
    const list = document.getElementById('spoolman-list');
    const grouped = RfidPort.groupSpools(
        spoolPickerSpools,
        spoolPickerContext,
        spoolPickerCurrentId,
        filter
    );
    list.innerHTML = '';

    if (grouped.conflicts.length) {
        const conflict = document.createElement('div');
        conflict.className = 'spoolman-picker-warning conflict';
        conflict.textContent = `Conflict: UID ${grouped.conflicts[0].uid} is linked to multiple spools (${grouped.conflicts[0].spoolIds.join(', ')}). Select explicitly.`;
        list.appendChild(conflict);
    }
    if (grouped.legacy.length && !grouped.linked.length) {
        const legacy = document.createElement('div');
        legacy.className = 'spoolman-picker-warning';
        legacy.textContent = `Legacy rfid_uid match found on spool(s) ${grouped.legacy.map(spool => `#${spool.id}`).join(', ')}. Assign one explicitly to migrate through SpoolLink.`;
        list.appendChild(legacy);
    }

    appendSpoolPickerGroup(list, 'Linked to this tag', grouped.linked);
    appendSpoolPickerGroup(list, 'Currently assigned', grouped.current);
    appendSpoolPickerGroup(list, 'Suggested', grouped.suggested, true);
    appendSpoolPickerGroup(list, 'All spools', grouped.all);

    if (!grouped.linked.length && !grouped.current.length
            && !grouped.suggested.length && !grouped.all.length) {
        const empty = document.createElement('div');
        empty.className = 'spoolman-empty';
        empty.textContent = 'No spools found';
        list.appendChild(empty);
    }
}

function spoolHasCardUid(spool, expectedUid) {
    if (!expectedUid) return true;
    const decoded = RfidPort.decodeExtra(spool?.extra?.card_uids);
    const values = Array.isArray(decoded)
        ? decoded
        : (typeof decoded === 'string' ? decoded.split(/[,;]+/) : []);
    return values.some(value => RfidPort.normalizeUid(value) === expectedUid);
}

async function waitForSpoolAssignment(channel, spoolId, expectedUid, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const [spool, status] = await Promise.all([
                fetchSpoolmanSpool(spoolId),
                queryAndSubscribe(),
            ]);
            const assignedId = Number(
                status?.print_task_config?.filament_spool_id?.[channel] || 0
            );
            if (assignedId === Number(spoolId)
                    && spoolHasCardUid(spool, expectedUid)) {
                return spool;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    const detail = lastError?.message ? `: ${lastError.message}` : '';
    throw new Error(`SpoolLink did not confirm the channel and card_uids update${detail}`);
}

async function pickSpool(spoolId) {
    if (spoolPickerChannel === null) return;
    const channel = spoolPickerChannel;
    const expectedUid = RfidPort.normalizeUid(
        spoolPickerContext?.uid || cachedUidForSlot(channel)
    );
    closeModal('spoolman-modal');
    try {
        showStatus('Assigning spool…', 'info');
        await sendGcode(`SET_SPOOL_ID LANE=E${channel} SPOOL_ID=${spoolId}`);
        const spool = await waitForSpoolAssignment(
            channel, spoolId, expectedUid
        );
        if (spool) spoolmanSpools.set(spoolId, spool);
        showStatus(`Spool #${spoolId} assigned to Extruder ${channel + 1}`, 'success');
    } catch (err) {
        showStatus(`Failed to assign spool: ${err.message}`, 'error');
    }
}

async function clearSpoolForChannel(channel) {
    closeModal('spoolman-modal');
    try {
        showStatus('Clearing spool…', 'info');
        await sendGcode(`SET_SPOOL_ID LANE=E${channel} SPOOL_ID=0`);
        showStatus(`Extruder ${channel + 1} assignment cleared; the tag remains linked in Spoolman`, 'success');
    } catch (err) {
        showStatus(`Failed to clear channel assignment: ${err.message}`, 'error');
    }
}

// ── Mismatch modal ────────────────────────────────────────────────────────

function openMismatchModal(channel) {
    const ch = channelsData.find(c => c.channel === channel);
    if (!ch) return;

    document.getElementById('mismatch-modal-title').textContent =
        `Tag Mismatch — Extruder ${channel + 1}`;
    document.getElementById('mismatch-apply').dataset.channel = channel;

    const rfid      = ch.rfid_data || {};
    const f         = ch.filament;
    const spoolInfo = ch.spool_id != null ? spoolmanSpools.get(ch.spool_id) : null;
    const sm        = spoolInfo?.filament || null;
    const smColor   = sm?.color_hex ? sm.color_hex.replace('#', '').toUpperCase() : null;

    const otherLabel   = sm ? 'Spoolman' : 'Printer Config';
    const otherType    = sm ? sm.material          : f.type;
    const otherVendor  = sm ? sm.vendor?.name      : f.brand;
    const otherSubtype = sm ? null                 : f.subtype;
    const otherColor   = sm ? smColor              : f.first_color;

    const cmpStr = (a, b) => !!(a && b && a.toLowerCase() !== b.toLowerCase());
    const cmpHex = (a, b) => !!(a && b && a !== b);
    const hexVal = h => h ? `#${h}` : '—';

    const rows = [];
    if (rfid.type     || otherType)    rows.push({ label: 'Type',    rfid: rfid.type     || '—', other: otherType    || '—', differs: cmpStr(rfid.type,     otherType) });
    if (rfid.vendor   || otherVendor)  rows.push({ label: 'Vendor',  rfid: rfid.vendor   || '—', other: otherVendor  || '—', differs: cmpStr(rfid.vendor,   otherVendor) });
    if (rfid.sub_type || otherSubtype) rows.push({ label: 'Subtype', rfid: rfid.sub_type || '—', other: otherSubtype || '—', differs: cmpStr(rfid.sub_type, otherSubtype) });
    if (rfid.color    || otherColor)   rows.push({ label: 'Color',   rfid: hexVal(rfid.color),   other: hexVal(otherColor),  differs: cmpHex(rfid.color, otherColor) });
    if (rfid.bed_temp != null) rows.push({ label: 'Bed',    rfid: `${rfid.bed_temp} °C`,                          other: '—', differs: false });
    if (rfid.min_temp != null) rows.push({ label: 'Hotend', rfid: `${rfid.min_temp}–${rfid.max_temp ?? '?'} °C`, other: '—', differs: false });

    const content = document.getElementById('mismatch-content');
    content.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'mismatch-row mismatch-header';
    hdr.innerHTML = `<span></span><span>RFID Tag</span><span>${escHtml(otherLabel)}</span>`;
    content.appendChild(hdr);

    rows.forEach(r => {
        const row = document.createElement('div');
        row.className = 'mismatch-row' + (r.differs ? ' mismatch-differs' : '');
        row.innerHTML =
            `<span class="mismatch-label">${escHtml(r.label)}</span>` +
            `<span class="mismatch-val">${escHtml(r.rfid)}</span>` +
            `<span class="mismatch-val">${escHtml(r.other)}</span>`;
        content.appendChild(row);
    });

    openModal('mismatch-modal');
}

// ── Modals ────────────────────────────────────────────────────────────────

function openModal(id) {
    const el = document.getElementById(id);
    if (el) { el.style.display = ''; document.body.classList.add('modal-open'); }
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
    if (!document.querySelector('.tag-edit-overlay:not([style*="none"])')) {
        document.body.classList.remove('modal-open');
    }
}

function initializeModals() {
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeModal('overwrite-modal'); closeModal('spoolman-modal');
            closeModal('mismatch-modal');
            closeModal('tag-details-modal'); closeModal('spoolman-fields-modal');
            closeSpoolmanMetadataSync();
            closeTigerTagEditor();
        }
    });

    document.getElementById('tag-details-close').addEventListener('click', () => closeModal('tag-details-modal'));
    document.getElementById('tag-details-done').addEventListener('click', () => closeModal('tag-details-modal'));
    document.getElementById('tag-details-modal').addEventListener('click', e => {
        if (e.target.id === 'tag-details-modal') closeModal('tag-details-modal');
    });

    document.getElementById('spoolman-fields-button').addEventListener('click', openSpoolmanFields);
    document.getElementById('spoolman-fields-close').addEventListener('click', () => closeModal('spoolman-fields-modal'));
    document.getElementById('spoolman-fields-cancel').addEventListener('click', () => closeModal('spoolman-fields-modal'));
    document.getElementById('spoolman-fields-refresh').addEventListener('click', () => void refreshSpoolmanFieldStatus());
    document.getElementById('spoolman-fields-add').addEventListener('click', () => void addSelectedSpoolmanFields());
    document.getElementById('spoolman-fields-modal').addEventListener('click', e => {
        if (e.target.id === 'spoolman-fields-modal') closeModal('spoolman-fields-modal');
    });

    document.getElementById('spoolman-sync-close').addEventListener('click', closeSpoolmanMetadataSync);
    document.getElementById('spoolman-sync-cancel').addEventListener('click', closeSpoolmanMetadataSync);
    document.getElementById('spoolman-sync-apply').addEventListener('click', () => void applySpoolmanMetadataSync());
    document.getElementById('spoolman-sync-modal').addEventListener('click', e => {
        if (e.target.id === 'spoolman-sync-modal') closeSpoolmanMetadataSync();
    });

    document.getElementById('tigertag-close').addEventListener('click', closeTigerTagEditor);
    document.getElementById('tigertag-cancel').addEventListener('click', closeTigerTagEditor);
    document.getElementById('tigertag-modal').addEventListener('click', e => {
        if (e.target.id === 'tigertag-modal') closeTigerTagEditor();
    });
    document.getElementById('tigertag-source-tag').addEventListener('click', loadTigerTagSourceFromTag);
    document.getElementById('tigertag-source-spool').addEventListener('click', loadTigerTagSourceFromSpool);
    document.getElementById('tigertag-form').addEventListener('submit', event => {
        void reviewTigerTagWrite(event);
    });
    document.getElementById('tigertag-aspect-1').addEventListener('change', updateTigerTagColorActivity);
    document.getElementById('tigertag-aspect-2').addEventListener('change', updateTigerTagColorActivity);
    document.getElementById('tigertag-message').addEventListener('input', setTigerTagMessageByteCount);
    document.getElementById('tigertag-allow-unrecognized').addEventListener('change', updateTigerTagAuthoringGate);
    document.getElementById('tigertag-allow-legacy').addEventListener('change', updateTigerTagAuthoringGate);
    document.getElementById('tigertag-preview-back').addEventListener('click', backToTigerTagEditor);
    document.getElementById('tigertag-confirm-write').addEventListener('click', () => {
        void confirmTigerTagWrite();
    });
    document.getElementById('tigertag-clear').addEventListener('click', () => {
        void clearTigerTag();
    });

    document.getElementById('mismatch-close').addEventListener('click', () => closeModal('mismatch-modal'));
    document.getElementById('mismatch-cancel').addEventListener('click', () => closeModal('mismatch-modal'));
    document.getElementById('mismatch-modal').addEventListener('click', e => {
        if (e.target.id === 'mismatch-modal') closeModal('mismatch-modal');
    });
    document.getElementById('mismatch-apply').addEventListener('click', async () => {
        const channel = parseInt(document.getElementById('mismatch-apply').dataset.channel);
        const ch = channelsData.find(c => c.channel === channel);
        const rfid = ch?.rfid_data;
        closeModal('mismatch-modal');
        if (!rfid || !rfid.type) {
            showStatus('No RFID filament data to apply', 'error');
            return;
        }
        // Push the tag's data straight into print_task_config rather than
        // re-reading the tag (FILAMENT_DT_UPDATE), which would fan out to a
        // Spoolman card-UID resolve and possibly overwrite the tag data.
        const colors = rfid.color ? [rfid.color] : [];
        const gcode = [
            'SET_PRINT_FILAMENT_CONFIG',
            `CONFIG_EXTRUDER=${channel}`,
            `VENDOR="${rfid.vendor || 'Generic'}"`,
            `FILAMENT_TYPE=${rfid.type}`,
            `FILAMENT_SUBTYPE="${rfid.sub_type || ''}"`,
            `COLOR_NUMS=${colors.length}`,
            `COLORS=${colors.join(',')}`,
            'MULTI_MODE=0',
            'ALPHA=255',
            'FORCE=1',
        ].join(' ');
        try {
            showStatus('Applying RFID data…', 'info');
            await sendGcode(gcode);
            showStatus('RFID data applied', 'success');
        } catch (err) {
            showStatus(`Failed: ${err.message}`, 'error');
        }
    });

    document.getElementById('spoolman-close').addEventListener('click', () => closeModal('spoolman-modal'));
    document.getElementById('spoolman-cancel').addEventListener('click', () => closeModal('spoolman-modal'));
    document.getElementById('spoolman-clear').addEventListener('click', () => {
        if (spoolPickerChannel !== null) clearSpoolForChannel(spoolPickerChannel);
    });
    document.getElementById('spoolman-modal').addEventListener('click', e => {
        if (e.target.id === 'spoolman-modal') closeModal('spoolman-modal');
    });
    document.getElementById('spoolman-search').addEventListener('input', e => {
        renderGroupedSpoolList(e.target.value);
    });

    document.querySelectorAll('.modal-close-ow').forEach(btn => {
        btn.addEventListener('click', () => closeModal('overwrite-modal'));
    });
    document.getElementById('overwrite-modal').addEventListener('click', e => {
        if (e.target.id === 'overwrite-modal') closeModal('overwrite-modal');
    });

    document.getElementById('overwrite-form').addEventListener('submit', handleOverwriteFilament);

    document.getElementById('ow-color-opacity').addEventListener('input', updateAllColorPreviews);
    initColorSlots();

    initFilamentPalette('material');
    initFilamentPalette('brand');
    initFilamentPalette('subtype');
    document.getElementById('ow-brand-custom').addEventListener('input', e => {
        document.getElementById('ow-brand-value').value = e.target.value.trim();
    });
}

// ── Reset channel ─────────────────────────────────────────────────────────

async function resetChannel(channel) {
    if (!wsReady) return;
    try {
        showStatus(`Resetting extruder ${channel + 1}…`, 'info');
        await sendGcode(`FILAMENT_DT_CLEAR CHANNEL=${channel}`);
        showStatus(`Extruder ${channel + 1} reset`, 'success');
    } catch (err) {
        showStatus(`Reset failed: ${err.message}`, 'error');
    }
}

// ── User filament ─────────────────────────────────────────────────────────

const FILAMENT_MAX_COLORS = 3;

// Tap-to-select palettes (mirrors repos/PrintTag-Web's material-palette pattern)
const FILAMENT_PALETTES = {
    material: {
        paletteId: 'ow-material-palette',
        valueId: 'ow-material-value',
        items: ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PVA', 'NYLON',
                'PLA-CF', 'PETG-CF', 'PA-CF', 'ABS-GF',
                'PA', 'PC-ABS', 'HIPS', 'BVOH'],
        defaultValue: 'PLA',
    },
    brand: {
        paletteId: 'ow-brand-palette',
        valueId: 'ow-brand-value',
        items: ['Generic', 'Bambu Lab', 'Hatchbox', 'eSun', 'Overture',
                'SUNLU', 'Polymaker', 'Prusament', 'Snapmaker', 'Jayo'],
        defaultValue: 'Generic',
        customInputId: 'ow-brand-custom',
    },
    subtype: {
        paletteId: 'ow-subtype-palette',
        valueId: 'ow-subtype-value',
        items: [{ label: 'None', value: '' }, 'Basic', 'Matte', 'SnapSpeed', 'Silk', 'Support', 'HF',
                '95A', '95A HF', '90A', '85A', 'Wood', 'Translucent'],
        defaultValue: 'Basic',
    },
};

function itemLabel(item) { return typeof item === 'object' ? item.label : item; }
function itemValue(item) { return typeof item === 'object' ? item.value : item; }

function createPaletteTile(label, value, onSelect) {
    const tile = document.createElement('div');
    tile.className = 'palette-tile';
    tile.textContent = label;
    tile.dataset.value = value;
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.addEventListener('click', onSelect);
    tile.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
    });
    return tile;
}

function initFilamentPalette(name) {
    const config = FILAMENT_PALETTES[name];
    const palette = document.getElementById(config.paletteId);
    palette.innerHTML = '';
    config.items.forEach(item => {
        const value = itemValue(item);
        palette.appendChild(createPaletteTile(itemLabel(item), value, () => setFilamentPaletteValue(name, value)));
    });
    if (config.customInputId) {
        palette.appendChild(createPaletteTile('Custom', 'custom', () => setFilamentPaletteValue(name, 'custom')));
    }
}

function setFilamentPaletteValue(name, value) {
    const config = FILAMENT_PALETTES[name];
    const valueInput = document.getElementById(config.valueId);
    const isCustom = !!config.customInputId && value === 'custom';

    if (config.customInputId) {
        const customInput = document.getElementById(config.customInputId);
        if (isCustom) {
            customInput.style.display = '';
            customInput.focus();
            valueInput.value = customInput.value.trim() || '';
        } else {
            customInput.style.display = 'none';
            valueInput.value = value;
        }
    } else {
        valueInput.value = value;
    }

    const selectedTileValue = isCustom ? 'Custom' : value;
    document.querySelectorAll(`#${config.paletteId} .palette-tile`).forEach(tile => {
        tile.classList.toggle('selected', tile.dataset.value === selectedTileValue);
    });
}

// Selects `value`, adding a one-off tile for it first if it isn't one of the
// known items (e.g. a subtype set previously via free text, or RFID data).
function setFilamentValue(name, value) {
    const config = FILAMENT_PALETTES[name];
    if (value == null) { setFilamentPaletteValue(name, config.defaultValue); return; }
    if (config.items.some(item => itemValue(item) === value)) { setFilamentPaletteValue(name, value); return; }
    if (!value) { setFilamentPaletteValue(name, config.defaultValue); return; }
    if (config.customInputId) {
        document.getElementById(config.customInputId).value = value;
        setFilamentPaletteValue(name, 'custom');
        return;
    }
    const palette = document.getElementById(config.paletteId);
    if (![...palette.children].some(t => t.dataset.value === value)) {
        palette.appendChild(createPaletteTile(value, value, () => setFilamentPaletteValue(name, value)));
    }
    setFilamentPaletteValue(name, value);
}

// ── HSV color picker (ported from repos/PrintTag-Web/public/color.js) ──────

function hsvToRgb(h, s, v) {
    let r, g, b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) {
        h = 0;
    } else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h, s, v];
}

function hexToHsv(hex) {
    const val = hex.replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(val)) return null;
    return rgbToHsv(parseInt(val.slice(0, 2), 16), parseInt(val.slice(2, 4), 16), parseInt(val.slice(4, 6), 16));
}

function hsvToHex(h, s, v) {
    return hsvToRgb(h, s, v).map(c => c.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function drawHueArea(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) {
        const stop = i / 6;
        const [r, g, b] = hsvToRgb(stop, 1, 1);
        grad.addColorStop(stop, `rgb(${r},${g},${b})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
}

function drawSVSquare(ctx, w, h, hue) {
    const [r, g, b] = hsvToRgb(hue, 1, 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, w, h);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, 'rgba(255,255,255,1)');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, h);
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, h);
}

function drawSVMarker(ctx, w, h, s, v) {
    const x = Math.max(0, Math.min(w, Math.round(s * w)));
    const y = Math.max(0, Math.min(h, Math.round((1 - v) * h)));
    const r = Math.max(4, Math.floor(Math.min(w, h) * 0.04));
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.stroke();
    ctx.restore();
}

function drawHueMarker(ctx, w, h, hue) {
    const x = Math.max(0, Math.min(w, Math.round(hue * w)));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 3, 0);
    ctx.lineTo(x + 3, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.restore();
}

function sizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}

// ── Color slots (up to FILAMENT_MAX_COLORS, pre-created and toggleable) ────

const colorSlotState = Array.from({ length: FILAMENT_MAX_COLORS }, () => ({ hue: 0, s: 0, v: 1, enabled: false }));
colorSlotState[0].enabled = true;

function redrawColorSlot(index) {
    const slot = document.querySelector(`.color-slot[data-index="${index}"]`);
    const st = colorSlotState[index];
    const sv = slot.querySelector('.color-sv');
    const hue = slot.querySelector('.color-hue');
    if (!sv || !hue) return;

    const svCtx = sv.getContext('2d');
    drawSVSquare(svCtx, sv.width, sv.height, st.hue);
    drawSVMarker(svCtx, sv.width, sv.height, st.s, st.v);

    const hueCtx = hue.getContext('2d');
    drawHueArea(hueCtx, hue.width, hue.height);
    drawHueMarker(hueCtx, hue.width, hue.height, st.hue);
}

function updateColorSlotPreview(index) {
    const st = colorSlotState[index];
    const slot = document.querySelector(`.color-slot[data-index="${index}"]`);
    const preview = slot && slot.querySelector('.color-preview');
    if (!preview) return;
    const percent = parseInt(document.getElementById('ow-color-opacity').value, 10) || 0;
    const [r, g, b] = hsvToRgb(st.hue, st.s, st.v);
    preview.style.setProperty('--preview-color', `rgba(${r}, ${g}, ${b}, ${percent / 100})`);
}

function updateAllColorPreviews() {
    const percent = parseInt(document.getElementById('ow-color-opacity').value, 10) || 0;
    const alphaHex = Math.round(percent / 100 * 255).toString(16).padStart(2, '0').toUpperCase();
    document.getElementById('ow-color-alpha').value = alphaHex;
    document.getElementById('ow-color-opacity-value').textContent = `${percent}%`;
    colorSlotState.forEach((st, i) => { if (st.enabled) updateColorSlotPreview(i); });
}

function applyColorSlotChange(index) {
    const st = colorSlotState[index];
    const slot = document.querySelector(`.color-slot[data-index="${index}"]`);
    const hexInput = slot.querySelector('.color-hex-input');
    hexInput.value = hsvToHex(st.hue, st.s, st.v);
    redrawColorSlot(index);
    updateColorSlotPreview(index);
}

function attachDrag(el, onPick) {
    const pick = (clientX, clientY) => {
        const rect = el.getBoundingClientRect();
        onPick((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height);
    };
    let dragging = false;
    el.addEventListener('mousedown', e => { dragging = true; pick(e.clientX, e.clientY); });
    el.addEventListener('mousemove', e => { if (dragging) pick(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { dragging = false; });
    el.addEventListener('touchstart', e => { pick(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    el.addEventListener('touchmove', e => {
        pick(e.touches[0].clientX, e.touches[0].clientY);
        e.preventDefault();
    }, { passive: false });
}

function renderColorSlotContent(index) {
    const slot = document.querySelector(`.color-slot[data-index="${index}"]`);
    const st = colorSlotState[index];

    slot.innerHTML =
        `<div class="color-slot-header">` +
            `<input type="text" class="color-hex-input" maxlength="6" spellcheck="false">` +
            `<div class="color-preview" aria-hidden="true"></div>` +
            (index === 0 ? '' : `<button type="button" class="color-toggle-btn" aria-label="Remove color">&times;</button>`) +
        `</div>` +
        `<canvas class="color-sv"></canvas>` +
        `<canvas class="color-hue"></canvas>`;

    const hexInput = slot.querySelector('.color-hex-input');
    const svCanvas = slot.querySelector('.color-sv');
    const hueCanvas = slot.querySelector('.color-hue');

    hexInput.addEventListener('input', () => {
        const hsv = hexToHsv(hexInput.value);
        if (!hsv) return;
        [st.hue, st.s, st.v] = hsv;
        redrawColorSlot(index);
        updateColorSlotPreview(index);
    });

    attachDrag(svCanvas, (x, y) => {
        st.s = Math.max(0, Math.min(1, x));
        st.v = 1 - Math.max(0, Math.min(1, y));
        applyColorSlotChange(index);
    });
    attachDrag(hueCanvas, (x) => {
        st.hue = Math.max(0, Math.min(1, x));
        applyColorSlotChange(index);
    });

    if (index !== 0) {
        slot.querySelector('.color-toggle-btn').addEventListener('click', () => disableColorSlot(index));
    }

    sizeCanvas(svCanvas);
    sizeCanvas(hueCanvas);
    applyColorSlotChange(index);
}

// Renders exactly the currently-enabled slots, followed by a single
// "+ Add color" button (hidden once FILAMENT_MAX_COLORS is reached).
function renderColorList() {
    const list = document.getElementById('ow-color-list');
    list.innerHTML = '';

    let activeCount = 0;
    colorSlotState.forEach((st, i) => {
        if (!st.enabled) return;
        activeCount++;
        const slot = document.createElement('div');
        slot.className = 'color-slot';
        slot.dataset.index = i;
        list.appendChild(slot);
        renderColorSlotContent(i);
    });

    if (activeCount < FILAMENT_MAX_COLORS) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'color-slot-add-btn';
        addBtn.textContent = '+ Add color';
        addBtn.addEventListener('click', () => {
            const next = colorSlotState.findIndex(st => !st.enabled);
            if (next !== -1) enableColorSlot(next);
        });
        list.appendChild(addBtn);
    }
}

function enableColorSlot(index) {
    colorSlotState[index].enabled = true;
    colorSlotState[index].hue = 0;
    colorSlotState[index].s = 0;
    colorSlotState[index].v = 1;
    renderColorList();
}

function disableColorSlot(index) {
    colorSlotState[index].enabled = false;
    renderColorList();
}

function initColorSlots() {
    renderColorList();
}

function setColorSlots(hexes) {
    const list = hexes.length ? hexes : ['FFFFFF'];
    colorSlotState.forEach((st, i) => {
        st.enabled = i === 0 || i < list.length;
        const hsv = hexToHsv(list[i] || 'FFFFFF') || [0, 0, 1];
        [st.hue, st.s, st.v] = hsv;
    });
    renderColorList();
}

function resizeVisibleColorCanvases() {
    colorSlotState.forEach((st, i) => {
        if (!st.enabled) return;
        const slot = document.querySelector(`.color-slot[data-index="${i}"]`);
        sizeCanvas(slot.querySelector('.color-sv'));
        sizeCanvas(slot.querySelector('.color-hue'));
        redrawColorSlot(i);
    });
}

function openOverwriteModal(channel) {
    const form = document.getElementById('overwrite-form');
    document.getElementById('overwrite-modal-title').textContent = `User Filament — Extruder ${channel + 1}`;
    form.reset();
    form.elements.channel.value = channel;
    setFilamentValue('material', 'PLA');
    setFilamentValue('brand', 'Generic');
    setFilamentValue('subtype', 'Basic');
    document.getElementById('ow-color-opacity').value = 100;
    setColorSlots(['FFFFFF']);

    const ch = channelsData.find(c => c.channel === channel);
    if (ch && ch.filament && ch.filament.type) {
        setFilamentValue('material', ch.filament.type);
        if (ch.filament.brand)   setFilamentValue('brand', ch.filament.brand);
        if (ch.filament.subtype != null) setFilamentValue('subtype', ch.filament.subtype);
        if (ch.filament.first_color) {
            setColorSlots([ch.filament.first_color, ...(ch.filament.additional_colors || [])]);
            const alpha = ch.filament.alpha !== undefined ? ch.filament.alpha : 0xFF;
            document.getElementById('ow-color-opacity').value = Math.round(alpha / 255 * 100);
        }
    }

    const sources = [];
    if (ch && ch.official) sources.push('an RFID tag');
    if (ch && ch.spool_id != null) sources.push('Spoolman');
    const warningEl = document.getElementById('overwrite-warning');
    if (sources.length) {
        warningEl.textContent = `This extruder's filament is currently set from ${sources.join(' and ')}. Saving here will overwrite it.`;
        warningEl.style.display = '';
    } else {
        warningEl.style.display = 'none';
    }

    updateAllColorPreviews();
    openModal('overwrite-modal');
    resizeVisibleColorCanvases();
}

async function handleOverwriteFilament(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const channel  = formData.get('channel');
    const type     = formData.get('type');
    const brand    = (formData.get('brand')   || 'Generic').trim();
    const subtype  = (formData.get('subtype') ?? '').trim();
    const alphaHex = (formData.get('alpha') || 'FF').trim().toUpperCase();
    const alphaDec = parseInt(alphaHex, 16);

    const colors = colorSlotState
        .filter(st => st.enabled)
        .map(st => hsvToHex(st.hue, st.s, st.v));

    const gcode = [
        'SET_PRINT_FILAMENT_CONFIG',
        `CONFIG_EXTRUDER=${channel}`,
        `VENDOR="${brand}"`,
        `FILAMENT_TYPE=${type}`,
        `FILAMENT_SUBTYPE="${subtype}"`,
        `COLOR_NUMS=${colors.length}`,
        `COLORS=${colors.join(',')}`,
        'MULTI_MODE=0',
        `ALPHA=${alphaDec}`,
        'FORCE=1',
    ].join(' ');

    try {
        showStatus('Setting filament…', 'info');
        await sendGcode(gcode);
        closeModal('overwrite-modal');
        showStatus(`Extruder ${parseInt(channel) + 1} filament set`, 'success');
    } catch (err) {
        showStatus(`Failed: ${err.message}`, 'error');
    }
}

// ── Event listeners ───────────────────────────────────────────────────────

function initializeEventListeners() {
    const btn = document.getElementById('refresh-all');
    if (btn) btn.addEventListener('click', refreshAllChannels);
}

// ── Status toast ──────────────────────────────────────────────────────────

function showStatus(message, type = 'info') {
    const el = document.getElementById('status-message');
    if (!el) return;
    el.textContent = message;
    el.className = `status-message status-${type}`;
    el.classList.add('show');
    if (type !== 'error') setTimeout(() => el.classList.remove('show'), 5000);
}
