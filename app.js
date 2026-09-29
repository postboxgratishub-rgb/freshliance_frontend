(() => {
  'use strict';

  const POLL_INTERVAL_MS = 3000;
  const OFFLINE_AFTER_MS = 120000;
  const ADMIN_KEY_STORAGE = 'fieldlink_admin_key';
  const API_BASE_STORAGE = 'freshliance_api_base_url';
  const DEFAULT_DEVICE_ID = 'NODE-001';
  const MAX_CHART_POINTS = 120;
  const API_BASE_URL = resolveApiBaseUrl();

  function normalizeApiBaseUrl(value) {
    if (!value || typeof value !== 'string') return '';
    const candidate = value.trim();
    if (!candidate || candidate.includes('YOUR-RENDER-SERVICE')) return '';
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch (_) {
      return '';
    }
  }

  function resolveApiBaseUrl() {
    const pageUrl = new URL(window.location.href);
    const suppliedBase = pageUrl.searchParams.get('api');

    try {
      if (suppliedBase === 'clear') {
        localStorage.removeItem(API_BASE_STORAGE);
      } else if (suppliedBase) {
        const normalized = normalizeApiBaseUrl(suppliedBase);
        if (normalized) localStorage.setItem(API_BASE_STORAGE, normalized);
      }
      if (suppliedBase) {
        pageUrl.searchParams.delete('api');
        window.history.replaceState({}, '', `${pageUrl.pathname}${pageUrl.search}${pageUrl.hash}`);
      }
      const storedBase = normalizeApiBaseUrl(localStorage.getItem(API_BASE_STORAGE));
      if (storedBase) return storedBase;
    } catch (_) {
      // Storage may be unavailable in private browsing; config.js remains available.
    }

    return normalizeApiBaseUrl(window.FRESHLANCE_CONFIG?.API_BASE_URL);
  }

  function apiUrl(path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return API_BASE_URL ? `${API_BASE_URL}${normalizedPath}` : normalizedPath;
  }

  const metricInfo = {
    temperature: { label: 'Temperature', unit: '°C', decimals: 1, color: '#d76744' },
    humidity: { label: 'Humidity', unit: '%', decimals: 1, color: '#397190' },
    light: { label: 'Light exposure', unit: 'lux', decimals: 0, color: '#a96718' }
  };

  const metricIcons = {
    temperature: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 14.8V5a4 4 0 0 0-8 0v9.8a6 6 0 1 0 8 0ZM10 4a1 1 0 0 1 1 1v11.5l.5.3a3 3 0 1 1-3 0l.5-.3V5a1 1 0 0 1 1-1Z"/></svg>',
    humidity: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8S5 10.4 5 15a7 7 0 0 0 14 0c0-4.6-7-12.2-7-12.2ZM9 15.5a3 3 0 0 0 3 3"/></svg>',
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9Zm-2 14h4M12 1v3M4.2 4.2l2.1 2.1m11.4 0 2.1-2.1M2 12h3m14 0h3"/></svg>'
  };

  const state = {
    devices: [],
    deviceId: DEFAULT_DEVICE_ID,
    dashboard: null,
    chartMetric: 'temperature',
    requestPending: false,
    fetchError: null,
    lastSuccessAt: null,
    authAsked: false
  };

  const elements = {};
  let pollTimer;
  let clockTimer;

  const $ = (id) => document.getElementById(id);

  function cacheElements() {
    [
      'alertCount', 'lastUpdated', 'deviceSelect', 'refreshButton', 'copyEndpointButton',
      'shipmentStatus', 'shipmentId', 'systemConnection', 'temperatureValue',
      'temperatureState', 'temperatureDetail', 'humidityValue', 'humidityState',
      'humidityDetail', 'lightValue', 'lightState', 'lightDetail', 'connectivityState',
      'connectivityValue', 'lastSeen', 'chartMetricLabel', 'chartCurrent', 'chartMin',
      'chartMax', 'chartPlaceholder', 'historyChart', 'chartGrid', 'chartArea', 'chartLine',
      'chartPoints', 'chartLabels', 'chartTooltip', 'chartWrap', 'chartTitle',
      'chartDescription', 'thresholdContent', 'addThresholdButton', 'alertsBody',
      'thresholdDialog', 'thresholdForm', 'thresholdDialogTitle', 'thresholdId',
      'thresholdMetric', 'thresholdMin', 'thresholdMax', 'thresholdHysteresis',
      'thresholdConsecutive', 'thresholdEmail', 'thresholdEnabled', 'thresholdFormError',
      'saveThresholdButton', 'toastRegion', 'footerDevice', 'pageBanner',
      'pageBannerTitle', 'pageBannerMessage', 'bannerRetry'
    ].forEach((id) => { elements[id] = $(id); });
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  async function apiFetch(path, options = {}, allowAuthRetry = true) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body) headers.set('Content-Type', 'application/json');
    const adminKey = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (adminKey) headers.set('X-Admin-Key', adminKey);

    let response;
    try {
      response = await fetch(apiUrl(path), { ...options, headers, cache: 'no-store' });
    } catch (_) {
      throw new ApiError('The monitoring service could not be reached.', 0);
    }

    if (response.status === 401 && allowAuthRetry) {
      sessionStorage.removeItem(ADMIN_KEY_STORAGE);
      const key = requestAdminKey();
      if (key) {
        sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
        return apiFetch(path, options, false);
      }
    }

    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const body = await response.json();
        message = body.message || body.error?.message || (typeof body.error === 'string' ? body.error : message);
      } catch (_) {
        const text = await response.text().catch(() => '');
        if (text) message = text;
      }
      throw new ApiError(message, response.status);
    }
    return response.status === 204 ? null : response.json();
  }

  function requestAdminKey() {
    if (state.authAsked) return '';
    state.authAsked = true;
    const value = window.prompt('Administrator access is required. Enter the admin API key:');
    return typeof value === 'string' ? value.trim() : '';
  }

  function unwrapArray(value, keys = []) {
    if (Array.isArray(value)) return value;
    for (const key of keys) {
      if (Array.isArray(value?.[key])) return value[key];
    }
    return [];
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
  }

  function toNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function toTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function canonicalMetric(value) {
    const metric = String(value || '').toLowerCase();
    if (['temp', 'temperaturec', 'temperature_c'].includes(metric)) return 'temperature';
    if (['rh', 'relativehumidity'].includes(metric)) return 'humidity';
    if (['lux', 'lightlux', 'light_lux'].includes(metric)) return 'light';
    return metricInfo[metric] ? metric : 'temperature';
  }

  function normalizeReading(raw = {}) {
    const values = raw.values || raw.metrics || raw.data || {};
    return {
      time: toTime(firstDefined(raw.recordedAt, raw.timestamp, raw.createdAt, raw.receivedAt, raw.time)),
      temperature: toNumber(firstDefined(raw.temperature, raw.temperatureC, raw.temp, values.temperature, values.temperatureC, values.temp)),
      humidity: toNumber(firstDefined(raw.humidity, raw.relativeHumidity, values.humidity, values.relativeHumidity)),
      light: toNumber(firstDefined(raw.light, raw.lux, raw.lightLux, values.light, values.lux, values.lightLux)),
      rssi: toNumber(firstDefined(raw.rssi, raw.signalStrength, raw.wifiRssi, values.rssi))
    };
  }

  function normalizeThreshold(raw = {}) {
    return {
      id: String(firstDefined(raw.id, raw.thresholdId, raw._id, '')),
      metric: canonicalMetric(firstDefined(raw.metric, raw.sensor, raw.type)),
      min: toNumber(firstDefined(raw.min, raw.minValue, raw.minimum, raw.low)),
      max: toNumber(firstDefined(raw.max, raw.maxValue, raw.maximum, raw.high)),
      hysteresis: toNumber(firstDefined(raw.hysteresis, raw.hysteresisValue, 0)) ?? 0,
      consecutive: Math.max(1, Math.round(toNumber(firstDefined(raw.consecutiveReadings, raw.consecutive, raw.readingCount, 1)) || 1)),
      email: String(firstDefined(raw.recipientEmail, raw.email, raw.recipient, '')),
      enabled: Boolean(firstDefined(raw.enabled, raw.isEnabled, raw.active, true))
    };
  }

  function normalizeNotificationStatus(value, sent, error) {
    const status = String(value || '').trim().toUpperCase();
    if (['SENT', 'DELIVERED', 'SUCCESS', 'SUCCESSFUL'].includes(status) || sent === true) return 'SENT';
    if (['PENDING', 'QUEUED', 'SENDING'].includes(status)) return 'PENDING';
    if (['FAILED', 'ERROR', 'BOUNCED'].includes(status) || error) return 'FAILED';
    return 'SENT';
  }

  function normalizeAlert(raw = {}) {
    const metric = canonicalMetric(firstDefined(raw.metric, raw.sensor, raw.type));
    const eventType = String(firstDefined(raw.eventType, raw.event, 'OPEN')).toUpperCase();
    const direction = String(firstDefined(raw.direction, raw.breachDirection, '')).toLowerCase();
    const defaultMessage = eventType === 'RECOVERY'
      ? `${metricInfo[metric].label} returned to normal`
      : direction === 'high'
        ? `${metricInfo[metric].label} above maximum`
        : direction === 'low'
          ? `${metricInfo[metric].label} below minimum`
          : `${metricInfo[metric].label} threshold crossed`;
    return {
      id: String(firstDefined(raw.id, raw.alertId, raw._id, `${Date.now()}-${Math.random()}`)),
      metric,
      value: toNumber(firstDefined(raw.value, raw.readingValue, raw.measuredValue)),
      message: String(firstDefined(raw.message, raw.reason, raw.title, defaultMessage)),
      recipient: String(firstDefined(raw.recipientEmail, raw.email, raw.recipient, '—')),
      time: toTime(firstDefined(raw.triggeredAt, raw.createdAt, raw.timestamp, raw.time)),
      emailStatus: normalizeNotificationStatus(
        firstDefined(raw.emailStatus, raw.deliveryStatus, raw.notificationStatus),
        firstDefined(raw.emailSent, raw.sentAt, raw.deliveredAt),
        firstDefined(raw.emailError, raw.deliveryError)
      ),
      smsStatus: normalizeNotificationStatus(
        firstDefined(raw.smsStatus, raw.textStatus, raw.smsDeliveryStatus),
        firstDefined(raw.smsSent, raw.textSent, raw.smsSentAt),
        firstDefined(raw.smsError, raw.textError)
      ),
      severity: String(firstDefined(raw.severity, raw.level, 'warning')).toLowerCase(),
      eventType,
      direction
    };
  }

  function normalizeDevice(raw = {}) {
    const id = String(firstDefined(raw.id, raw.deviceId, raw.identifier, DEFAULT_DEVICE_ID));
    return {
      id,
      name: String(firstDefined(raw.name, raw.label, id)),
      shipmentId: String(firstDefined(raw.shipmentId, raw.shipment, raw.assignment?.shipmentId, id === DEFAULT_DEVICE_ID ? 'SHIP-001' : '—')),
      online: firstDefined(raw.online, raw.isOnline, raw.connected),
      lastSeen: toTime(firstDefined(raw.lastSeenAt, raw.lastSeen, raw.lastReadingAt, raw.updatedAt))
    };
  }

  function normalizeDashboard(payload = {}) {
    const data = payload.dashboard || payload.data || payload;
    const readings = unwrapArray(data.readings, ['items', 'data', 'results'])
      .map(normalizeReading)
      .filter((reading) => reading.time || Object.keys(metricInfo).some((metric) => reading[metric] !== null))
      .sort((a, b) => (a.time || 0) - (b.time || 0))
      .slice(-MAX_CHART_POINTS);
    const latestSource = firstDefined(data.latestReading, data.latest);
    const latest = latestSource ? normalizeReading(latestSource) : (readings.at(-1) || null);
    if (latest && !latest.time && readings.at(-1)?.time) latest.time = readings.at(-1).time;
    return {
      device: normalizeDevice(data.device || { deviceId: state.deviceId }),
      latest,
      readings,
      thresholds: unwrapArray(data.thresholds, ['items', 'data', 'results']).map(normalizeThreshold),
      alerts: unwrapArray(data.alerts, ['items', 'data', 'results']).map(normalizeAlert)
        .sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 50),
      openAlertCount: Math.max(0, Number(data.openAlertCount) || 0)
    };
  }

  async function loadDevices() {
    try {
      const response = await apiFetch('/api/devices');
      state.devices = unwrapArray(response, ['devices', 'items', 'data', 'results']).map(normalizeDevice);
    } catch (_) {
      state.devices = [];
    }
    if (!state.devices.some((device) => device.id === DEFAULT_DEVICE_ID)) {
      state.devices.unshift(normalizeDevice({ deviceId: DEFAULT_DEVICE_ID, shipmentId: 'SHIP-001' }));
    }
    renderDeviceSelect();
  }

  async function pollDashboard({ announce = false } = {}) {
    if (state.requestPending) return;
    if (announce) state.authAsked = false;
    state.requestPending = true;
    elements.refreshButton.classList.add('is-spinning');
    elements.refreshButton.setAttribute('aria-busy', 'true');
    try {
      const response = await apiFetch(`/api/dashboard?deviceId=${encodeURIComponent(state.deviceId)}`);
      state.dashboard = normalizeDashboard(response);
      state.fetchError = null;
      state.lastSuccessAt = Date.now();
      hidePageError();
      renderAll();
      if (announce) showToast('Dashboard refreshed.');
    } catch (error) {
      state.fetchError = error;
      showPageError(error);
      if (!state.dashboard) renderUnavailableStates();
      renderConnection();
      if (announce) showToast(error.message || 'Refresh failed.', true);
    } finally {
      state.requestPending = false;
      elements.refreshButton.classList.remove('is-spinning');
      elements.refreshButton.removeAttribute('aria-busy');
    }
  }

  function renderDeviceSelect() {
    elements.deviceSelect.replaceChildren();
    state.devices.forEach((device) => {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.name === device.id ? device.id : `${device.id} · ${device.name}`;
      option.selected = device.id === state.deviceId;
      elements.deviceSelect.appendChild(option);
    });
    elements.deviceSelect.disabled = false;
  }

  function renderAll() {
    if (!state.dashboard) return;
    const device = state.dashboard.device;
    elements.shipmentId.textContent = device.shipmentId || '—';
    elements.footerDevice.textContent = `${device.id || state.deviceId} · ${device.shipmentId || 'No shipment assigned'}`;
    renderMetrics();
    renderConnection();
    renderChart();
    renderThresholds();
    renderAlerts();
    renderUpdatedTime();
  }

  function thresholdFor(metric) {
    return state.dashboard?.thresholds.find((threshold) => threshold.metric === metric && threshold.enabled) || null;
  }

  function breachDirection(value, rule) {
    if (!Number.isFinite(value) || !rule) return null;
    if (Number.isFinite(rule.min) && value < rule.min) return 'low';
    if (Number.isFinite(rule.max) && value > rule.max) return 'high';
    return null;
  }

  function renderMetrics() {
    const latest = state.dashboard.latest;
    let anyBreach = false;
    Object.entries(metricInfo).forEach(([metric, info]) => {
      const value = latest?.[metric];
      const rule = thresholdFor(metric);
      const direction = breachDirection(value, rule);
      const card = document.querySelector(`.metric-card[data-metric="${metric}"]`);
      const valueElement = elements[`${metric}Value`];
      const stateElement = elements[`${metric}State`];
      const detailElement = elements[`${metric}Detail`];
      valueElement.textContent = Number.isFinite(value) ? formatNumber(value, info.decimals) : '—';
      stateElement.className = 'metric-state';
      card.classList.toggle('alerting', Boolean(direction));
      if (!Number.isFinite(value)) {
        stateElement.textContent = 'No data';
        stateElement.classList.add('neutral');
        detailElement.textContent = 'Waiting for a sensor reading';
      } else if (direction) {
        anyBreach = true;
        stateElement.textContent = direction === 'high' ? 'Above limit' : 'Below limit';
        stateElement.classList.add('danger');
        detailElement.textContent = direction === 'high' ? `Maximum ${formatMetric(rule.max, metric)}` : `Minimum ${formatMetric(rule.min, metric)}`;
      } else {
        stateElement.textContent = rule ? 'In range' : 'Live';
        if (!rule) stateElement.classList.add('neutral');
        detailElement.textContent = rule ? `Target ${formatRange(rule, metric)}` : 'No active threshold';
      }
    });
    elements.shipmentStatus.className = `status-chip ${anyBreach ? 'danger' : 'good'}`;
    elements.shipmentStatus.innerHTML = `<span></span> ${anyBreach ? 'Needs attention' : 'Within limits'}`;
  }

  function isDeviceOnline() {
    const explicit = state.dashboard?.device?.online;
    const lastTime = state.dashboard?.latest?.time || state.dashboard?.device?.lastSeen;
    if (explicit === false || !lastTime) return false;
    return Date.now() - lastTime <= OFFLINE_AFTER_MS;
  }

  function renderConnection() {
    const online = isDeviceOnline();
    const latest = state.dashboard?.latest;
    const lastTime = latest?.time || state.dashboard?.device?.lastSeen;
    const connection = elements.systemConnection;
    connection.classList.toggle('online', online && !state.fetchError);
    connection.classList.toggle('offline', !online || Boolean(state.fetchError));
    const title = connection.querySelector('strong');
    const detail = connection.querySelector('small');
    if (state.fetchError) {
      title.textContent = 'Service unavailable';
      detail.textContent = 'Retrying automatically';
    } else if (online) {
      title.textContent = 'Device online';
      detail.textContent = `${state.deviceId} · telemetry active`;
    } else {
      title.textContent = 'Device offline';
      detail.textContent = lastTime ? `Last reading ${relativeTime(lastTime)}` : 'No readings received';
    }
    elements.connectivityState.className = `metric-state${online ? '' : ' danger'}`;
    elements.connectivityState.textContent = online ? 'Connected' : 'Offline';
    elements.connectivityValue.textContent = online ? 'Online' : 'Offline';
    const signal = latest?.rssi;
    elements.lastSeen.textContent = lastTime ? `Last seen ${relativeTime(lastTime)}${Number.isFinite(signal) ? ` · ${signal} dBm` : ''}` : 'Last seen: never';
  }

  function renderChart() {
    const info = metricInfo[state.chartMetric];
    const readings = (state.dashboard?.readings || []).filter((reading) => Number.isFinite(reading[state.chartMetric]));
    elements.chartMetricLabel.textContent = info.label;
    elements.chartTitle.textContent = `${info.label} history`;
    if (!readings.length) {
      elements.historyChart.classList.add('is-hidden');
      elements.chartPlaceholder.classList.remove('is-hidden');
      elements.chartPlaceholder.classList.add('empty');
      elements.chartPlaceholder.innerHTML = '<p>No readings available for this metric.</p>';
      elements.chartCurrent.textContent = '—';
      elements.chartMin.textContent = 'Low —';
      elements.chartMax.textContent = 'High —';
      return;
    }
    elements.chartPlaceholder.classList.add('is-hidden');
    elements.historyChart.classList.remove('is-hidden');
    const values = readings.map((reading) => reading[state.chartMetric]);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = Math.max((rawMax - rawMin) * 0.18, state.chartMetric === 'light' ? 10 : 0.5);
    const min = rawMin - padding;
    const max = rawMax + padding;
    const xStart = 55, xEnd = 884, yTop = 15, yBottom = 224;
    const xAt = (index) => xStart + (index / Math.max(1, readings.length - 1)) * (xEnd - xStart);
    const yAt = (value) => yTop + ((max - value) / Math.max(0.0001, max - min)) * (yBottom - yTop);
    const points = readings.map((reading, index) => ({ x: xAt(index), y: yAt(reading[state.chartMetric]), reading }));
    const line = smoothPath(points);
    elements.chartLine.setAttribute('d', line);
    elements.chartArea.setAttribute('d', `${line} L ${points.at(-1).x} ${yBottom} L ${points[0].x} ${yBottom} Z`);
    elements.chartLine.style.stroke = info.color;
    document.querySelector('#chartGradient stop:first-child').setAttribute('stop-color', info.color);
    elements.chartCurrent.textContent = formatMetric(values.at(-1), state.chartMetric);
    elements.chartMin.textContent = `Low ${formatMetric(rawMin, state.chartMetric)}`;
    elements.chartMax.textContent = `High ${formatMetric(rawMax, state.chartMetric)}`;
    elements.chartDescription.textContent = `${readings.length} readings. Latest ${formatMetric(values.at(-1), state.chartMetric)}.`;
    renderChartGrid(min, max, xStart, xEnd, yTop, yBottom, readings);
    renderChartPoints(points, info);
  }

  function smoothPath(points) {
    if (!points.length) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const middle = (previous.x + current.x) / 2;
      path += ` C ${middle.toFixed(2)} ${previous.y.toFixed(2)}, ${middle.toFixed(2)} ${current.y.toFixed(2)}, ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
    }
    return path;
  }

  function svgElement(tag, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  function renderChartGrid(min, max, xStart, xEnd, yTop, yBottom, readings) {
    elements.chartGrid.replaceChildren();
    elements.chartLabels.replaceChildren();
    for (let index = 0; index < 4; index += 1) {
      const ratio = index / 3;
      const y = yTop + ratio * (yBottom - yTop);
      elements.chartGrid.appendChild(svgElement('line', { x1: xStart, y1: y, x2: xEnd, y2: y, class: 'chart-grid-line' }));
      const label = svgElement('text', { x: 4, y: y + 3, class: 'chart-axis-label' });
      label.textContent = formatNumber(max - ratio * (max - min), metricInfo[state.chartMetric].decimals);
      elements.chartLabels.appendChild(label);
    }
    const labelCount = Math.min(5, readings.length);
    for (let index = 0; index < labelCount; index += 1) {
      const readingIndex = Math.round((index / Math.max(1, labelCount - 1)) * (readings.length - 1));
      const x = xStart + (index / Math.max(1, labelCount - 1)) * (xEnd - xStart);
      const label = svgElement('text', { x, y: 257, class: 'chart-time-label', 'text-anchor': index === 0 ? 'start' : index === labelCount - 1 ? 'end' : 'middle' });
      label.textContent = readings[readingIndex].time ? formatTime(readings[readingIndex].time) : `#${readingIndex + 1}`;
      elements.chartLabels.appendChild(label);
    }
  }

  function renderChartPoints(points, info) {
    elements.chartPoints.replaceChildren();
    points.forEach((point, index) => {
      if (index === points.length - 1) elements.chartPoints.appendChild(svgElement('circle', { cx: point.x, cy: point.y, r: 4, class: 'chart-point', style: `stroke:${info.color}` }));
      const hit = svgElement('circle', { cx: point.x, cy: point.y, r: 9, class: 'chart-hit-point', tabindex: '0' });
      const show = () => showChartTooltip(point);
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', hideChartTooltip);
      hit.addEventListener('blur', hideChartTooltip);
      elements.chartPoints.appendChild(hit);
    });
  }

  function showChartTooltip(point) {
    elements.chartTooltip.innerHTML = `<strong>${escapeHtml(formatMetric(point.reading[state.chartMetric], state.chartMetric))}</strong><small>${escapeHtml(point.reading.time ? formatDateTime(point.reading.time) : 'Time unavailable')}</small>`;
    elements.chartTooltip.style.left = `${(point.x / 900) * elements.chartWrap.clientWidth}px`;
    elements.chartTooltip.style.top = `${(point.y / 280) * elements.chartWrap.clientHeight}px`;
    elements.chartTooltip.classList.remove('is-hidden');
  }

  function hideChartTooltip() {
    elements.chartTooltip.classList.add('is-hidden');
  }

  function renderThresholds() {
    const thresholds = state.dashboard?.thresholds || [];
    if (!thresholds.length) {
      elements.thresholdContent.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg><strong>No thresholds configured</strong><p>Add a rule to begin monitoring sensor limits and sending email alerts.</p><button class="text-button" type="button" data-add-threshold>Add the first threshold</button></div>';
      return;
    }
    elements.thresholdContent.innerHTML = `<div class="threshold-list">${thresholds.map((threshold) => {
      const info = metricInfo[threshold.metric];
      return `<article class="threshold-row">
        <div class="threshold-main"><span class="metric-icon ${threshold.metric}" aria-hidden="true">${metricIcons[threshold.metric]}</span><span><strong>${escapeHtml(info.label)}</strong><small>${threshold.enabled ? 'Monitoring active' : 'Monitoring paused'}</small></span></div>
        <div class="threshold-values"><strong>${escapeHtml(formatRange(threshold, threshold.metric))}</strong><small>Hysteresis ${escapeHtml(formatMetric(threshold.hysteresis, threshold.metric))} · ${threshold.consecutive} reading${threshold.consecutive === 1 ? '' : 's'}</small></div>
        <div class="threshold-recipient"><strong title="${escapeHtml(threshold.email)}">${escapeHtml(threshold.email || 'No recipient')}</strong><small>Email recipient</small></div>
        <div class="threshold-actions"><label class="mini-toggle" title="${threshold.enabled ? 'Disable' : 'Enable'} rule"><span class="sr-only">Enable ${escapeHtml(info.label)} threshold</span><input type="checkbox" data-toggle-threshold="${escapeHtml(threshold.id)}" ${threshold.enabled ? 'checked' : ''} /><span aria-hidden="true"></span></label><button class="row-action" type="button" data-edit-threshold="${escapeHtml(threshold.id)}" aria-label="Edit ${escapeHtml(info.label)} threshold"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5L9 20H4v-5L14 5Zm-7 8 4 4"/></svg></button><button class="row-action delete" type="button" data-delete-threshold="${escapeHtml(threshold.id)}" aria-label="Delete ${escapeHtml(info.label)} threshold"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg></button></div>
      </article>`;
    }).join('')}</div>`;
  }

  function renderAlerts() {
    const alerts = state.dashboard?.alerts || [];
    const openCount = state.dashboard?.openAlertCount || 0;
    elements.alertCount.textContent = String(Math.min(openCount, 99));
    elements.alertCount.setAttribute('aria-label', `${openCount} open alerts`);
    if (!alerts.length) {
      elements.alertsBody.innerHTML = '<tr class="table-empty"><td colspan="5">No alerts have been recorded for this device.</td></tr>';
      return;
    }
    elements.alertsBody.innerHTML = alerts.map((alert) => {
      const info = metricInfo[alert.metric];
      const isRecovery = ['RECOVERY', 'RECOVERED', 'RESOLVED', 'CLOSED'].includes(alert.eventType);
      const indicatorClass = isRecovery ? 'resolved' : alert.severity === 'critical' ? 'critical' : '';
      const notificationStatus = isRecovery
        ? '<div class="notification-status"><span class="table-status recovered">Recovered</span></div>'
        : `<div class="notification-status"><span class="table-status ${alert.emailStatus.toLowerCase()}">${escapeHtml(notificationStatusLabel('Email', alert.emailStatus))}</span><span class="table-status ${alert.smsStatus.toLowerCase()}">${escapeHtml(notificationStatusLabel('SMS', alert.smsStatus))}</span></div>`;
      return `<tr><td><div class="alert-event"><span class="alert-indicator ${indicatorClass}"></span><span><strong title="${escapeHtml(alert.message)}">${escapeHtml(alert.message)}</strong><small>${escapeHtml(info?.label || alert.metric)} · ${isRecovery ? 'recovery' : escapeHtml(alert.direction || 'breach')}</small></span></div></td><td class="reading-cell">${Number.isFinite(alert.value) ? escapeHtml(formatMetric(alert.value, alert.metric)) : '—'}</td><td class="email-cell" title="${escapeHtml(alert.recipient)}">${escapeHtml(alert.recipient)}</td><td title="${escapeHtml(alert.time ? formatDateTime(alert.time) : 'Time unavailable')}">${alert.time ? escapeHtml(relativeTime(alert.time)) : '—'}</td><td>${notificationStatus}</td></tr>`;
    }).join('');
  }

  function notificationStatusLabel(channel, status) {
    const label = { SENT: 'sent', PENDING: 'pending', FAILED: 'failed' }[status] || 'sent';
    return `${channel} ${label}`;
  }

  function renderUnavailableStates() {
    elements.chartPlaceholder.classList.remove('is-hidden');
    elements.chartPlaceholder.classList.add('empty');
    elements.chartPlaceholder.innerHTML = '<p>Sensor history is unavailable.</p>';
    elements.historyChart.classList.add('is-hidden');
    elements.thresholdContent.innerHTML = '<div class="error-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.7 19h18.6L12 3Zm0 5v5m0 3v.1"/></svg><strong>Thresholds unavailable</strong><p>Reconnect to the service, then retry.</p><button class="text-button" type="button" data-retry>Retry now</button></div>';
    elements.alertsBody.innerHTML = '<tr class="table-error"><td colspan="5">Recent alerts are unavailable. The dashboard will retry automatically.</td></tr>';
    ['temperature', 'humidity', 'light'].forEach((metric) => {
      elements[`${metric}Value`].textContent = '—';
      elements[`${metric}State`].textContent = 'Unavailable';
      elements[`${metric}State`].className = 'metric-state neutral';
      elements[`${metric}Detail`].textContent = 'No reading received';
    });
  }

  function showPageError(error) {
    elements.pageBannerTitle.textContent = error?.status === 401 ? 'Administrator key required' : 'Live data unavailable';
    elements.pageBannerMessage.textContent = error?.message || 'Check the service connection and try again.';
    elements.pageBanner.classList.remove('is-hidden');
  }

  function hidePageError() {
    elements.pageBanner.classList.add('is-hidden');
  }

  function renderUpdatedTime() {
    elements.lastUpdated.textContent = state.lastSuccessAt ? `Updated ${relativeTime(state.lastSuccessAt)}` : 'Waiting for data…';
  }

  function openThresholdDialog(threshold = null) {
    elements.thresholdDialogTitle.textContent = threshold ? 'Edit threshold' : 'Add threshold';
    elements.thresholdId.value = threshold?.id || '';
    elements.thresholdMetric.value = threshold?.metric || 'temperature';
    elements.thresholdMetric.disabled = Boolean(threshold);
    elements.thresholdMin.value = Number.isFinite(threshold?.min) ? threshold.min : '';
    elements.thresholdMax.value = Number.isFinite(threshold?.max) ? threshold.max : '';
    elements.thresholdHysteresis.value = Number.isFinite(threshold?.hysteresis) ? threshold.hysteresis : '0.5';
    elements.thresholdConsecutive.value = threshold?.consecutive || '2';
    elements.thresholdEmail.value = threshold?.email || '';
    elements.thresholdEnabled.checked = threshold ? threshold.enabled : true;
    elements.thresholdFormError.classList.add('is-hidden');
    elements.thresholdDialog.showModal();
  }

  function thresholdPayload() {
    const min = toNumber(elements.thresholdMin.value);
    const max = toNumber(elements.thresholdMax.value);
    const hysteresis = toNumber(elements.thresholdHysteresis.value);
    const consecutiveReadings = Math.round(toNumber(elements.thresholdConsecutive.value) || 0);
    if (min === null && max === null) throw new Error('Enter at least one minimum or maximum value.');
    if (min !== null && max !== null && min >= max) throw new Error('Minimum must be lower than maximum.');
    if (hysteresis === null || hysteresis < 0) throw new Error('Hysteresis must be zero or greater.');
    if (consecutiveReadings < 1) throw new Error('Consecutive readings must be at least 1.');
    if (!elements.thresholdEmail.checkValidity()) throw new Error('Enter a valid recipient email.');
    return { deviceId: state.deviceId, metric: elements.thresholdMetric.value, min, max, hysteresis, consecutive: consecutiveReadings, recipientEmail: elements.thresholdEmail.value.trim(), enabled: elements.thresholdEnabled.checked };
  }

  async function saveThreshold(event) {
    event.preventDefault();
    let payload;
    try { payload = thresholdPayload(); } catch (error) { showFormError(error.message); return; }
    const id = elements.thresholdId.value;
    elements.saveThresholdButton.disabled = true;
    elements.saveThresholdButton.textContent = 'Saving…';
    try {
      if (id) {
        delete payload.deviceId;
        delete payload.metric;
      }
      await apiFetch(id ? `/api/thresholds/${encodeURIComponent(id)}` : '/api/thresholds', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      elements.thresholdDialog.close();
      showToast(id ? 'Threshold updated.' : 'Threshold added.');
      await pollDashboard();
    } catch (error) {
      showFormError(error.message || 'The threshold could not be saved.');
    } finally {
      elements.saveThresholdButton.disabled = false;
      elements.saveThresholdButton.textContent = 'Save threshold';
    }
  }

  function showFormError(message) {
    elements.thresholdFormError.textContent = message;
    elements.thresholdFormError.classList.remove('is-hidden');
  }

  async function toggleThreshold(id, enabled, input) {
    input.disabled = true;
    try {
      await apiFetch(`/api/thresholds/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      showToast(`Threshold ${enabled ? 'enabled' : 'paused'}.`);
      await pollDashboard();
    } catch (error) {
      input.checked = !enabled;
      showToast(error.message || 'Threshold could not be updated.', true);
    } finally { input.disabled = false; }
  }

  async function deleteThreshold(id) {
    const threshold = state.dashboard?.thresholds.find((item) => item.id === id);
    if (!threshold || !window.confirm(`Delete the ${metricInfo[threshold.metric].label.toLowerCase()} threshold? This cannot be undone.`)) return;
    try {
      await apiFetch(`/api/thresholds/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('Threshold deleted.');
      await pollDashboard();
    } catch (error) { showToast(error.message || 'Threshold could not be deleted.', true); }
  }

  async function copyDeviceEndpoint() {
    const endpoint = new URL(apiUrl('/api/sensor-readings'), window.location.href).href;
    try {
      await navigator.clipboard.writeText(endpoint);
      showToast(`Device endpoint copied: ${endpoint}`);
    } catch (_) { window.prompt('Copy the device endpoint:', endpoint); }
  }

  function setupEvents() {
    elements.refreshButton.addEventListener('click', () => pollDashboard({ announce: true }));
    elements.bannerRetry.addEventListener('click', () => pollDashboard({ announce: true }));
    elements.copyEndpointButton.addEventListener('click', copyDeviceEndpoint);
    elements.addThresholdButton.addEventListener('click', () => openThresholdDialog());
    elements.thresholdForm.addEventListener('submit', saveThreshold);
    document.querySelectorAll('[data-close-threshold]').forEach((button) => button.addEventListener('click', () => elements.thresholdDialog.close()));
    elements.deviceSelect.addEventListener('change', async () => {
      state.deviceId = elements.deviceSelect.value;
      state.dashboard = null;
      state.fetchError = null;
      showLoadingStates();
      await pollDashboard();
    });
    document.querySelectorAll('[data-chart-metric]').forEach((button) => button.addEventListener('click', () => {
      state.chartMetric = button.dataset.chartMetric;
      document.querySelectorAll('[data-chart-metric]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
      renderChart();
    }));
    elements.thresholdContent.addEventListener('click', (event) => {
      const add = event.target.closest('[data-add-threshold]');
      const retry = event.target.closest('[data-retry]');
      const edit = event.target.closest('[data-edit-threshold]');
      const remove = event.target.closest('[data-delete-threshold]');
      if (add) openThresholdDialog();
      if (retry) pollDashboard({ announce: true });
      if (edit) {
        const threshold = state.dashboard?.thresholds.find((item) => item.id === edit.dataset.editThreshold);
        if (threshold) openThresholdDialog(threshold);
      }
      if (remove) deleteThreshold(remove.dataset.deleteThreshold);
    });
    elements.thresholdContent.addEventListener('change', (event) => {
      const input = event.target.closest('[data-toggle-threshold]');
      if (input) toggleThreshold(input.dataset.toggleThreshold, input.checked, input);
    });
    document.querySelectorAll('.nav-item').forEach((link) => link.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('is-active', item === link));
    }));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (!state.lastSuccessAt || Date.now() - state.lastSuccessAt > POLL_INTERVAL_MS)) pollDashboard();
    });
  }

  function showLoadingStates() {
    elements.thresholdContent.innerHTML = '<div class="skeleton-list" aria-label="Loading thresholds"><div></div><div></div><div></div></div>';
    elements.alertsBody.innerHTML = '<tr class="loading-row"><td colspan="5"><span class="loading-ring"></span> Loading recent alerts…</td></tr>';
    elements.chartPlaceholder.classList.remove('is-hidden', 'empty');
    elements.chartPlaceholder.innerHTML = '<span class="loading-ring" aria-hidden="true"></span><p>Loading sensor history…</p>';
    elements.historyChart.classList.add('is-hidden');
  }

  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function formatRange(rule, metric) {
    if (Number.isFinite(rule.min) && Number.isFinite(rule.max)) return `${formatNumber(rule.min, metricInfo[metric].decimals)}–${formatMetric(rule.max, metric)}`;
    if (Number.isFinite(rule.min)) return `≥ ${formatMetric(rule.min, metric)}`;
    if (Number.isFinite(rule.max)) return `≤ ${formatMetric(rule.max, metric)}`;
    return 'No limits';
  }

  function formatMetric(value, metric) {
    const info = metricInfo[metric] || { unit: '', decimals: 1 };
    return `${formatNumber(value, info.decimals)} ${info.unit}`.trim();
  }

  function formatNumber(value, decimals = 1) {
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function formatTime(time) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(time));
  }

  function formatDateTime(time) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
  }

  function relativeTime(time) {
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  async function init() {
    cacheElements();
    setupEvents();
    showLoadingStates();
    await loadDevices();
    await pollDashboard();
    pollTimer = window.setInterval(pollDashboard, POLL_INTERVAL_MS);
    clockTimer = window.setInterval(() => { renderUpdatedTime(); if (state.dashboard) renderConnection(); }, 1000);
  }

  window.addEventListener('beforeunload', () => { window.clearInterval(pollTimer); window.clearInterval(clockTimer); });
  document.addEventListener('DOMContentLoaded', init);
})();
