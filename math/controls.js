(function (global) {
    const statusDurationMs = 1600;
    const warningStatusDurationMs = 20000;
    const presetDbName = 'animation_presets';
    const presetDbVersion = 1;
    const presetsStoreName = 'presets';
    const pageStateStoreName = 'page_state';

    let databasePromise = null;

    function decimalPlaces(value) {
        const text = String(value ?? '');
        if (!text.includes('.')) {
            return 0;
        }
        return text.split('.')[1].length;
    }

    function roundToDecimals(value, decimals) {
        if (decimals <= 0) {
            return Math.round(value);
        }
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
        });
    }

    function openPresetDatabase() {
        if (!global.indexedDB) {
            return Promise.reject(new Error('IndexedDB is not available in this browser'));
        }

        if (databasePromise) {
            return databasePromise;
        }

        databasePromise = new Promise((resolve, reject) => {
            const request = global.indexedDB.open(presetDbName, presetDbVersion);

            request.onupgradeneeded = () => {
                const database = request.result;

                let presetsStore;
                if (!database.objectStoreNames.contains(presetsStoreName)) {
                    presetsStore = database.createObjectStore(presetsStoreName, {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                } else {
                    presetsStore = request.transaction.objectStore(presetsStoreName);
                }

                if (!presetsStore.indexNames.contains('pageId')) {
                    presetsStore.createIndex('pageId', 'pageId', { unique: false });
                }

                if (!presetsStore.indexNames.contains('pageId_name')) {
                    presetsStore.createIndex('pageId_name', ['pageId', 'name'], { unique: true });
                }

                if (!database.objectStoreNames.contains(pageStateStoreName)) {
                    database.createObjectStore(pageStateStoreName, { keyPath: 'pageId' });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
        }).catch((error) => {
            databasePromise = null;
            throw error;
        });

        return databasePromise;
    }

    async function listPresets(pageId) {
        const database = await openPresetDatabase();
        const transaction = database.transaction(presetsStoreName, 'readonly');
        const index = transaction.objectStore(presetsStoreName).index('pageId');
        const presets = await requestToPromise(index.getAll(IDBKeyRange.only(pageId)));
        await transactionDone(transaction);

        return presets.sort((left, right) => {
            const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
            if (nameCompare !== 0) {
                return nameCompare;
            }
            return (right.updatedAt || 0) - (left.updatedAt || 0);
        });
    }

    async function loadPreset(presetId) {
        if (presetId == null || presetId === '') {
            return null;
        }

        const numericId = Number(presetId);
        const database = await openPresetDatabase();
        const transaction = database.transaction(presetsStoreName, 'readonly');
        const preset = await requestToPromise(transaction.objectStore(presetsStoreName).get(numericId));
        await transactionDone(transaction);
        return preset || null;
    }

    async function savePreset(pageId, name, values, overwriteId) {
        const trimmedName = String(name || '').trim();
        if (!trimmedName) {
            throw new Error('Preset name is required');
        }

        const numericOverwriteId = overwriteId == null ? null : Number(overwriteId);
        const database = await openPresetDatabase();
        const transaction = database.transaction([presetsStoreName, pageStateStoreName], 'readwrite');
        const presetsStore = transaction.objectStore(presetsStoreName);
        const pageStateStore = transaction.objectStore(pageStateStoreName);
        const index = presetsStore.index('pageId_name');

        const existingByName = await requestToPromise(index.get([pageId, trimmedName]));
        let record;

        if (numericOverwriteId != null) {
            const existingById = await requestToPromise(presetsStore.get(numericOverwriteId));
            if (!existingById || existingById.pageId !== pageId) {
                throw new Error('Preset to overwrite was not found');
            }
            if (existingByName && existingByName.id !== numericOverwriteId) {
                throw new Error('A different preset already uses that name');
            }

            record = {
                ...existingById,
                name: trimmedName,
                values,
                updatedAt: Date.now()
            };
        } else if (existingByName) {
            throw new Error('A preset with that name already exists');
        } else {
            record = {
                pageId,
                name: trimmedName,
                values,
                updatedAt: Date.now()
            };
        }

        const savedId = await requestToPromise(presetsStore.put(record));
        record.id = savedId;
        await requestToPromise(pageStateStore.put({ pageId, lastUsedPresetId: savedId }));
        await transactionDone(transaction);

        return record;
    }

    async function deletePreset(presetId) {
        if (presetId == null || presetId === '') {
            return null;
        }

        const numericId = Number(presetId);
        const database = await openPresetDatabase();
        const transaction = database.transaction([presetsStoreName, pageStateStoreName], 'readwrite');
        const presetsStore = transaction.objectStore(presetsStoreName);
        const pageStateStore = transaction.objectStore(pageStateStoreName);
        const preset = await requestToPromise(presetsStore.get(numericId));

        if (!preset) {
            await transactionDone(transaction);
            return null;
        }

        await requestToPromise(presetsStore.delete(numericId));

        const pageState = await requestToPromise(pageStateStore.get(preset.pageId));
        if (pageState && pageState.lastUsedPresetId === numericId) {
            await requestToPromise(pageStateStore.delete(preset.pageId));
        }

        await transactionDone(transaction);
        return preset;
    }

    async function setLastUsedPreset(pageId, presetId) {
        const database = await openPresetDatabase();
        const transaction = database.transaction(pageStateStoreName, 'readwrite');
        const pageStateStore = transaction.objectStore(pageStateStoreName);

        if (presetId == null || presetId === '') {
            await requestToPromise(pageStateStore.delete(pageId));
        } else {
            await requestToPromise(pageStateStore.put({
                pageId,
                lastUsedPresetId: Number(presetId)
            }));
        }

        await transactionDone(transaction);
    }

    async function loadLastUsedPreset(pageId) {
        const database = await openPresetDatabase();
        const transaction = database.transaction([pageStateStoreName, presetsStoreName], 'readonly');
        const pageStateStore = transaction.objectStore(pageStateStoreName);
        const presetsStore = transaction.objectStore(presetsStoreName);
        const pageState = await requestToPromise(pageStateStore.get(pageId));

        if (!pageState || pageState.lastUsedPresetId == null) {
            await transactionDone(transaction);
            return null;
        }

        const preset = await requestToPromise(presetsStore.get(Number(pageState.lastUsedPresetId)));
        await transactionDone(transaction);
        return preset || null;
    }

    function normalizeNumber(rawValue, control) {
        const min = Number(control.min);
        const max = Number(control.max);
        const step = Number(control.step);
        const defaultValue = Number(control.defaultValue);

        let numericValue = typeof control.parse === 'function'
            ? Number(control.parse(rawValue, control))
            : Number(rawValue);

        if (!Number.isFinite(numericValue)) {
            numericValue = defaultValue;
        }

        numericValue = clamp(numericValue, min, max);

        if (Number.isFinite(step) && step > 0) {
            numericValue = min + Math.round((numericValue - min) / step) * step;
            numericValue = roundToDecimals(
                numericValue,
                Math.max(decimalPlaces(step), decimalPlaces(min), decimalPlaces(max))
            );
            numericValue = clamp(numericValue, min, max);
        }

        return numericValue;
    }

    function serializeNumber(value, control) {
        const decimals = Math.max(
            decimalPlaces(control.step),
            decimalPlaces(control.min),
            decimalPlaces(control.max)
        );
        return String(roundToDecimals(value, decimals));
    }

    function serializeNumberForInput(value, control, element) {
        const stepSource = element?.step && element.step !== 'any'
            ? Number(element.step)
            : Number(control.step);
        const decimals = decimalPlaces(stepSource);
        return String(roundToDecimals(value, decimals));
    }

    function createPageControls(options) {
        const {
            pageId,
            params,
            controls,
            controlBoxId = 'control-box',
            panelTitle = 'Controls',
            collapseToggleId = 'control-box-toggle',
            presetNameInputId = 'preset-name-input',
            presetSelectId = 'preset-select',
            saveButtonId = 'save-config-btn',
            loadButtonId = 'load-preset-btn',
            deleteButtonId = 'delete-preset-btn',
            resetButtonId = 'reset-config-btn',
            statusId = 'config-status'
        } = options;

        const controlBox = document.getElementById(controlBoxId);
        const resetButton = document.getElementById(resetButtonId);
        const statusElement = document.getElementById(statusId);
        let statusTimer = null;
        let presetsCache = [];
        let activePresetId = null;
        let pendingOverwritePresetId = null;
        let pendingOverwritePresetName = '';
        let persistenceAvailable = true;

        function setStatus(message, state, durationMs = statusDurationMs) {
            if (!statusElement) {
                return;
            }

            statusElement.textContent = message || '';
            if (state) {
                statusElement.dataset.state = state;
            } else {
                delete statusElement.dataset.state;
            }

            if (statusTimer) {
                clearTimeout(statusTimer);
                statusTimer = null;
            }

            if (message && durationMs > 0) {
                statusTimer = setTimeout(() => {
                    statusElement.textContent = '';
                    delete statusElement.dataset.state;
                }, durationMs);
            }
        }

        function clearPendingOverwrite() {
            pendingOverwritePresetId = null;
            pendingOverwritePresetName = '';
        }

        function ensurePanelStructure() {
            if (!controlBox) {
                return {};
            }

            let controlBody = controlBox.querySelector('.control-box__body');
            let collapseToggle = document.getElementById(collapseToggleId);

            if (!controlBody) {
                controlBody = document.createElement('div');
                controlBody.className = 'control-box__body';

                while (controlBox.firstChild) {
                    controlBody.appendChild(controlBox.firstChild);
                }

                const header = document.createElement('div');
                header.className = 'control-box__header';

                const title = document.createElement('div');
                title.className = 'control-box__title';
                title.textContent = panelTitle;

                collapseToggle = document.createElement('button');
                collapseToggle.id = collapseToggleId;
                collapseToggle.type = 'button';
                collapseToggle.className = 'action-btn control-box__toggle';
                collapseToggle.setAttribute('aria-expanded', 'true');
                collapseToggle.textContent = 'Collapse';

                header.appendChild(title);
                header.appendChild(collapseToggle);
                controlBox.appendChild(header);
                controlBox.appendChild(controlBody);
            }

            return {
                collapseToggle,
                controlBody
            };
        }

        function ensurePresetUi() {
            if (!controlBox) {
                return {};
            }

            const panel = ensurePanelStructure();
            const controlBody = panel.controlBody || controlBox;

            const controlActions = document.getElementById(saveButtonId)?.closest('.control-actions')
                || controlBody.querySelector('.control-actions');

            let presetNameInput = document.getElementById(presetNameInputId);
            if (!presetNameInput) {
                const nameGroup = document.createElement('div');
                nameGroup.className = 'control-group';

                const label = document.createElement('label');
                label.htmlFor = presetNameInputId;
                label.textContent = 'Preset Name';

                presetNameInput = document.createElement('input');
                presetNameInput.id = presetNameInputId;
                presetNameInput.type = 'text';
                presetNameInput.className = 'control-input control-input--full';
                presetNameInput.placeholder = 'e.g. Glass Bloom';
                presetNameInput.autocomplete = 'off';
                presetNameInput.maxLength = 60;

                nameGroup.appendChild(label);
                nameGroup.appendChild(presetNameInput);
                controlBody.insertBefore(nameGroup, controlActions || statusElement || null);
            }

            let presetSelect = document.getElementById(presetSelectId);
            if (!presetSelect) {
                const selectGroup = document.createElement('div');
                selectGroup.className = 'control-group';

                const label = document.createElement('label');
                label.htmlFor = presetSelectId;
                label.textContent = 'Saved Presets';

                presetSelect = document.createElement('select');
                presetSelect.id = presetSelectId;
                presetSelect.className = 'control-input control-input--full control-select';

                selectGroup.appendChild(label);
                selectGroup.appendChild(presetSelect);
                controlBody.insertBefore(selectGroup, controlActions || statusElement || null);
            }

            let loadButton = document.getElementById(loadButtonId);
            let deleteButton = document.getElementById(deleteButtonId);
            if (!loadButton || !deleteButton) {
                const presetActions = document.createElement('div');
                presetActions.className = 'control-actions preset-actions';

                loadButton = document.createElement('button');
                loadButton.id = loadButtonId;
                loadButton.type = 'button';
                loadButton.className = 'action-btn';
                loadButton.textContent = 'Load';

                deleteButton = document.createElement('button');
                deleteButton.id = deleteButtonId;
                deleteButton.type = 'button';
                deleteButton.className = 'action-btn action-btn--danger';
                deleteButton.textContent = 'Delete';

                presetActions.appendChild(loadButton);
                presetActions.appendChild(deleteButton);
                controlBody.insertBefore(presetActions, controlActions || statusElement || null);
            }

            const saveButton = document.getElementById(saveButtonId);
            if (saveButton) {
                saveButton.textContent = 'Save As';
            }

            const resetButton = document.getElementById(resetButtonId);
            if (resetButton) {
                resetButton.classList.add('action-btn--danger');
            }

            return {
                collapseToggle: panel.collapseToggle || document.getElementById(collapseToggleId),
                presetNameInput,
                presetSelect,
                loadButton,
                deleteButton,
                saveButton,
                resetButton
            };
        }

        const presetUi = ensurePresetUi();
        const collapseToggle = presetUi.collapseToggle || document.getElementById(collapseToggleId);
        const presetNameInput = presetUi.presetNameInput || document.getElementById(presetNameInputId);
        const presetSelect = presetUi.presetSelect || document.getElementById(presetSelectId);
        const loadButton = presetUi.loadButton || document.getElementById(loadButtonId);
        const deleteButton = presetUi.deleteButton || document.getElementById(deleteButtonId);
        const saveButton = presetUi.saveButton || document.getElementById(saveButtonId);

        function getControlValue(control) {
            return params[control.key];
        }

        function collectValues() {
            const values = {};
            controls.forEach((control) => {
                values[control.key] = getControlValue(control);
            });
            return values;
        }

        function updateControlUi(control, value) {
            if (control.kind === 'checkbox') {
                if (control.checkboxElement) {
                    control.checkboxElement.checked = Boolean(value);
                }
                return;
            }

            const serializedValue = serializeNumber(value, control);
            if (control.rangeElement) {
                control.rangeElement.value = serializedValue;
            }
            if (control.numberElement) {
                control.numberElement.value = serializeNumberForInput(value, control, control.numberElement);
            }
            if (control.displayElement) {
                control.displayElement.textContent = control.formatValue
                    ? control.formatValue(value, params)
                    : serializedValue;
            }
        }

        function applyControlValue(control, rawValue, source) {
            let nextValue;

            if (control.kind === 'checkbox') {
                nextValue = typeof control.parse === 'function'
                    ? Boolean(control.parse(rawValue, control))
                    : Boolean(rawValue);
            } else {
                nextValue = normalizeNumber(rawValue, control);
            }

            params[control.key] = nextValue;
            updateControlUi(control, nextValue);

            if (activePresetId != null && (source === 'range' || source === 'number' || source === 'checkbox')) {
                clearPresetSelection({ clearName: false });
            }

            if (typeof control.onApply === 'function') {
                control.onApply(nextValue, {
                    control,
                    params,
                    source,
                    savePreset: handleSavePresetClick,
                    resetToDefaults
                });
            }

            return nextValue;
        }

        function applyValues(values, source) {
            controls.forEach((control) => {
                const nextValue = Object.prototype.hasOwnProperty.call(values, control.key)
                    ? values[control.key]
                    : control.defaultValue;
                applyControlValue(control, nextValue, source);
            });
        }

        function setPersistenceEnabled(enabled) {
            persistenceAvailable = enabled;
            if (presetNameInput) presetNameInput.disabled = !enabled;
            if (presetSelect) presetSelect.disabled = !enabled;
            if (saveButton) saveButton.disabled = !enabled;
            if (loadButton) loadButton.disabled = !enabled || !activePresetId;
            if (deleteButton) deleteButton.disabled = !enabled || !activePresetId;
        }

        function updatePresetActionState() {
            const hasActivePreset = activePresetId != null;
            if (loadButton) loadButton.disabled = !persistenceAvailable || !hasActivePreset;
            if (deleteButton) deleteButton.disabled = !persistenceAvailable || !hasActivePreset;
        }

        function syncPresetSelection() {
            if (presetSelect) {
                presetSelect.value = activePresetId == null ? '' : String(activePresetId);
            }
            updatePresetActionState();
        }

        function clearPresetSelection(options = {}) {
            const { clearName = true } = options;
            activePresetId = null;
            clearPendingOverwrite();
            if (presetSelect) {
                presetSelect.value = '';
            }
            if (clearName && presetNameInput) {
                presetNameInput.value = '';
            }
            updatePresetActionState();
        }

        function renderPresetList() {
            if (!presetSelect) {
                return;
            }

            presetSelect.innerHTML = '';

            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = presetsCache.length ? 'Select a preset' : 'No saved presets';
            presetSelect.appendChild(placeholder);

            presetsCache.forEach((preset) => {
                const option = document.createElement('option');
                option.value = String(preset.id);
                option.textContent = preset.name;
                presetSelect.appendChild(option);
            });

            syncPresetSelection();
        }

        async function refreshPresetList() {
            presetsCache = await listPresets(pageId);
            const activeStillExists = presetsCache.some((preset) => preset.id === activePresetId);
            if (!activeStillExists) {
                activePresetId = null;
            }
            const pendingStillExists = presetsCache.some((preset) => preset.id === pendingOverwritePresetId);
            if (!pendingStillExists) {
                clearPendingOverwrite();
            }
            renderPresetList();
            return presetsCache;
        }

        function getPresetById(presetId) {
            const numericId = Number(presetId);
            return presetsCache.find((preset) => preset.id === numericId) || null;
        }

        function getPresetByName(name) {
            return presetsCache.find((preset) => preset.name === name) || null;
        }

        async function applyPresetRecord(preset, source) {
            if (!preset) {
                return null;
            }

            activePresetId = preset.id;
            applyValues(preset.values || {}, source);
            syncPresetSelection();
            return preset;
        }

        function bindControl(control) {
            if (control.kind === 'checkbox') {
                control.checkboxElement = document.getElementById(control.inputId);
                if (control.checkboxElement) {
                    control.checkboxElement.addEventListener('change', (event) => {
                        applyControlValue(control, event.target.checked, 'checkbox');
                    });
                }
                return;
            }

            control.rangeElement = document.getElementById(control.inputId);
            control.numberElement = document.getElementById(control.numberInputId);
            control.displayElement = document.getElementById(control.displayId);

            if (control.rangeElement) {
                control.rangeElement.addEventListener('input', (event) => {
                    applyControlValue(control, event.target.value, 'range');
                });
            }

            if (control.numberElement) {
                const isIntermediateNumberInput = (rawValue) => {
                    return rawValue === ''
                        || rawValue === '-'
                        || rawValue === '.'
                        || rawValue === '-.'
                        || /^-?\d+\.$/.test(rawValue);
                };

                const commitNumber = (rawValue, source) => {
                    if (isIntermediateNumberInput(rawValue)) {
                        return false;
                    }
                    applyControlValue(control, rawValue, source);
                    return true;
                };

                control.numberElement.addEventListener('input', () => {
                    // Let users type freely; commit on enter/blur/change instead of
                    // normalizing mid-keystroke and moving the caret.
                });

                control.numberElement.addEventListener('change', (event) => {
                    commitNumber(event.target.value, 'number');
                    updateControlUi(control, getControlValue(control));
                });

                control.numberElement.addEventListener('blur', () => {
                    commitNumber(control.numberElement.value, 'number');
                    updateControlUi(control, getControlValue(control));
                });

                control.numberElement.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter') {
                        return;
                    }

                    event.preventDefault();
                    commitNumber(control.numberElement.value, 'number');
                    updateControlUi(control, getControlValue(control));
                    control.numberElement.blur();
                });
            }
        }

        async function handleSavePresetClick() {
            if (!persistenceAvailable) {
                setStatus('Presets are unavailable', 'error');
                return null;
            }

            const presetName = String(presetNameInput?.value || '').trim();
            if (!presetName) {
                setStatus('Enter a preset name', 'error');
                if (presetNameInput) presetNameInput.focus();
                return null;
            }

            const existingByName = getPresetByName(presetName);
            let overwriteId = null;

            if (existingByName) {
                const isConfirmedOverwrite = pendingOverwritePresetId === existingByName.id
                    && pendingOverwritePresetName === presetName;

                if (!isConfirmedOverwrite) {
                    pendingOverwritePresetId = existingByName.id;
                    pendingOverwritePresetName = presetName;
                    setStatus(
                        `Preset "${presetName}" exists. Click Save As again to overwrite.`,
                        'warning',
                        warningStatusDurationMs
                    );
                    return null;
                }

                overwriteId = existingByName.id;
            } else {
                clearPendingOverwrite();
            }

            try {
                const preset = await savePreset(pageId, presetName, collectValues(), overwriteId);
                activePresetId = preset.id;
                clearPendingOverwrite();
                await refreshPresetList();
                if (presetNameInput) {
                    presetNameInput.value = '';
                }
                syncPresetSelection();
                setStatus(`Saved preset "${preset.name}"`, 'success');
                return preset;
            } catch (error) {
                clearPendingOverwrite();
                setStatus('Save failed', 'error');
                return null;
            }
        }

        async function handleLoadPresetClick() {
            if (!persistenceAvailable) {
                setStatus('Presets are unavailable', 'error');
                return null;
            }

            const selectedId = presetSelect?.value;
            if (!selectedId) {
                setStatus('Select a preset to load', 'error');
                return null;
            }

            try {
                const preset = await loadPreset(selectedId);
                if (!preset || preset.pageId !== pageId) {
                    setStatus('Preset not found', 'error');
                    return null;
                }

                await applyPresetRecord(preset, 'load');
                await setLastUsedPreset(pageId, preset.id);
                setStatus(`Loaded preset "${preset.name}"`, 'success');
                return preset;
            } catch (error) {
                setStatus('Load failed', 'error');
                return null;
            }
        }

        async function handleDeletePresetClick() {
            if (!persistenceAvailable) {
                setStatus('Presets are unavailable', 'error');
                return null;
            }

            const selectedId = presetSelect?.value;
            const preset = selectedId ? getPresetById(selectedId) : null;
            if (!preset) {
                setStatus('Select a preset to delete', 'error');
                return null;
            }

            const confirmed = global.confirm(`Delete preset "${preset.name}"?`);
            if (!confirmed) {
                return null;
            }

            try {
                await deletePreset(preset.id);
                applyValues({}, 'reset');
                await setLastUsedPreset(pageId, null);
                clearPresetSelection();
                await refreshPresetList();
                setStatus(`Deleted preset "${preset.name}"`, 'success');
                return preset;
            } catch (error) {
                setStatus('Delete failed', 'error');
                return null;
            }
        }

        async function resetToDefaults() {
            applyValues({}, 'reset');
            clearPresetSelection();

            if (persistenceAvailable) {
                try {
                    await setLastUsedPreset(pageId, null);
                } catch (error) {
                    setStatus('Defaults restored, but preset state was not cleared', 'error');
                    return;
                }
            }

            setStatus('Defaults restored', 'success');
        }

        async function initialize() {
            controls.forEach((control) => {
                if (typeof control.defaultValue === 'undefined') {
                    control.defaultValue = params[control.key];
                }

                bindControl(control);
            });

            applyValues({}, 'initialize');

            if (presetSelect) {
                presetSelect.addEventListener('change', (event) => {
                    activePresetId = event.target.value ? Number(event.target.value) : null;
                    clearPendingOverwrite();
                    updatePresetActionState();
                });
            }

            if (presetNameInput) {
                presetNameInput.addEventListener('input', () => {
                    clearPendingOverwrite();
                });
            }

            if (saveButton) {
                saveButton.addEventListener('click', () => {
                    void handleSavePresetClick();
                });
            }

            if (collapseToggle && controlBox) {
                collapseToggle.addEventListener('click', () => {
                    const willCollapse = !controlBox.classList.contains('is-collapsed');
                    controlBox.classList.toggle('is-collapsed', willCollapse);
                    collapseToggle.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
                    collapseToggle.textContent = willCollapse ? 'Expand' : 'Collapse';
                });
            }

            if (loadButton) {
                loadButton.addEventListener('click', () => {
                    void handleLoadPresetClick();
                });
            }

            if (deleteButton) {
                deleteButton.addEventListener('click', () => {
                    void handleDeletePresetClick();
                });
            }

            if (resetButton) {
                resetButton.addEventListener('click', () => {
                    void resetToDefaults();
                });
            }

            try {
                setPersistenceEnabled(true);
                await refreshPresetList();
                const lastUsedPreset = await loadLastUsedPreset(pageId);
                if (lastUsedPreset && lastUsedPreset.pageId === pageId) {
                    await applyPresetRecord(lastUsedPreset, 'startup');
                } else {
                    clearPresetSelection();
                }
            } catch (error) {
                setPersistenceEnabled(false);
                clearPresetSelection();
                setStatus('IndexedDB presets unavailable', 'error');
            }
        }

        return {
            initialize,
            listPresets: () => listPresets(pageId),
            loadPreset: (presetId) => loadPreset(presetId),
            savePreset: (name, values, overwriteId) => savePreset(pageId, name, values, overwriteId),
            deletePreset,
            loadLastUsedPreset: () => loadLastUsedPreset(pageId),
            setLastUsedPreset: (presetId) => setLastUsedPreset(pageId, presetId),
            resetToDefaults,
            applyControlValue: (key, value, source = 'programmatic') => {
                const control = controls.find((candidate) => candidate.key === key);
                if (!control) {
                    return undefined;
                }
                return applyControlValue(control, value, source);
            }
        };
    }

    function isPointInsideElement(selector, x, y) {
        const element = document.querySelector(selector);
        if (!element) {
            return false;
        }

        const bounds = element.getBoundingClientRect();
        return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    }

    global.AnimationControls = {
        createPageControls,
        deletePreset,
        isPointInsideElement,
        listPresets,
        loadLastUsedPreset,
        loadPreset,
        savePreset,
        setLastUsedPreset
    };
})(window);
