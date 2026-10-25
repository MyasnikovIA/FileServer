// ============================================================
// 60-virtual-gamepad.js — Виртуальный джойстик для эмуляторов
// ============================================================

FAR.VirtualGamepad = (function () {
    // Маппинг клавиш, который ожидает EmulatorJS и другие ядра
    const KEYMAPS = {
        'nes': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'x',          code: 'KeyX',       keyCode: 88 },
            btnB:      { key: 'z',          code: 'KeyZ',       keyCode: 90 },
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
            select:    { key: 'Shift',      code: 'ShiftLeft',  keyCode: 16 }
        },
        'jsdos': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'Control',    code: 'ControlLeft', keyCode: 17 }, // Fire 1
            btnB:      { key: 'Alt',        code: 'AltLeft',    keyCode: 18 }, // Fire 2
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
            select:    { key: ' ',          code: 'Space',      keyCode: 32 }
        },
        'segaMD': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'a',          code: 'KeyA',       keyCode: 65 },
            btnB:      { key: 's',          code: 'KeyS',       keyCode: 83 },
            btnC:      { key: 'd',          code: 'KeyD',       keyCode: 68 },
            btnX:      { key: 'z',          code: 'KeyZ',       keyCode: 90 },
            btnY:      { key: 'x',          code: 'KeyX',       keyCode: 88 },
            btnZ:      { key: 'c',          code: 'KeyC',       keyCode: 67 },
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 }
        },
        'snes': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'x',          code: 'KeyX',       keyCode: 88 },
            btnB:      { key: 'z',          code: 'KeyZ',       keyCode: 90 },
            btnX:      { key: 's',          code: 'KeyS',       keyCode: 83 },
            btnY:      { key: 'a',          code: 'KeyA',       keyCode: 65 },
            btnL:      { key: 'q',          code: 'KeyQ',       keyCode: 81 },
            btnR:      { key: 'e',          code: 'KeyE',       keyCode: 69 },
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
            select:    { key: 'Shift',      code: 'ShiftLeft',  keyCode: 16 }
        },
        'gba': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'x',          code: 'KeyX',       keyCode: 88 },
            btnB:      { key: 'z',          code: 'KeyZ',       keyCode: 90 },
            btnL:      { key: 'q',          code: 'KeyQ',       keyCode: 81 },
            btnR:      { key: 'e',          code: 'KeyE',       keyCode: 69 },
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
            select:    { key: 'Shift',      code: 'ShiftLeft',  keyCode: 16 }
        },
        'psx': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'x',          code: 'KeyX',       keyCode: 88 }, // Cross
            btnB:      { key: 'z',          code: 'KeyZ',       keyCode: 90 }, // Circle
            btnX:      { key: 's',          code: 'KeyS',       keyCode: 83 }, // Square
            btnY:      { key: 'a',          code: 'KeyA',       keyCode: 65 }, // Triangle
            btnL:      { key: 'q',          code: 'KeyQ',       keyCode: 81 },
            btnR:      { key: 'e',          code: 'KeyE',       keyCode: 69 },
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
            select:    { key: 'Shift',      code: 'ShiftLeft',  keyCode: 16 }
        }
    };
    // Дефолтный маппинг (SNES-подобный), если консоль неизвестна
    KEYMAPS['default'] = KEYMAPS['snes'];

    // Конфигурация раскладок для разных консолей
    const LAYOUTS = {
        'nes':    { class: 'vg-layout-nes',    actions: ['B', 'A'], shoulders: [], system: ['select', 'start'] },
        'gb':     { class: 'vg-layout-nes',    actions: ['B', 'A'], shoulders: [], system: ['select', 'start'] },
        'gba':    { class: 'vg-layout-snes',   actions: ['B', 'A'], shoulders: ['L', 'R'], system: ['select', 'start'] },
        'snes':   { class: 'vg-layout-snes',   actions: ['Y', 'X', 'B', 'A'], shoulders: ['L', 'R'], system: ['select', 'start'] },
        'segaMD': { class: 'vg-layout-sega',   actions: ['X', 'Y', 'Z', 'A', 'B', 'C'], shoulders: [], system: ['start'] },
        'sega':   { class: 'vg-layout-sega',   actions: ['X', 'Y', 'Z', 'A', 'B', 'C'], shoulders: [], system: ['start'] },
        'psx':    { class: 'vg-layout-snes',   actions: ['Y', 'X', 'B', 'A'], shoulders: ['L1', 'R1'], system: ['select', 'start'] },
        'default':{ class: 'vg-layout-snes',   actions: ['Y', 'X', 'B', 'A'], shoulders: ['L', 'R'], system: ['select', 'start'] }
    };

    const instances = new WeakMap();

    function fireKey(container, type, keyConfig) {
        if (!keyConfig) return;

        const ev = new KeyboardEvent(type, {
            key: keyConfig.key,
            code: keyConfig.code,
            keyCode: keyConfig.keyCode,
            which: keyConfig.keyCode,
            bubbles: true,
            cancelable: true,
            composed: true
        });

        container.dispatchEvent(ev);
        const canvas = container.querySelector('canvas');
        if (canvas) {
            try { canvas.dispatchEvent(ev); } catch(e){}
        }
        document.dispatchEvent(ev);
        window.dispatchEvent(ev);
    }

    function bindBtn(el, container, keyConfig) {
        if (!keyConfig) return;

        let isPressed = false;

        const down = function (e) {
            if (e) e.preventDefault();
            if (isPressed) return;
            isPressed = true;
            el.classList.add('active');
            fireKey(container, 'keydown', keyConfig);
        };

        const up = function (e) {
            if (e) e.preventDefault();
            if (!isPressed) return;
            isPressed = false;
            el.classList.remove('active');
            fireKey(container, 'keyup', keyConfig);
        };

        el.addEventListener('pointerdown', down);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
    }

    return {
        /**
         * Монтирует джойстик.
         * @param {HTMLElement} container — корневой элемент эмулятора
         * @param {string} coreType — 'nes' | 'segaMD' | 'snes' и т.д.
         */
        mount: function (container, coreType) {
            if (!container || instances.has(container)) return;

            // Приводим тип к нижнему регистру для надежности
            const type = (coreType || 'default').toLowerCase();

            // Ищем подходящий маппинг и раскладку (с фолбэком на default)
            let map = KEYMAPS[type];
            if (!map) {
                // Если точного совпадения нет, ищем по частичному (напр. 'segaMD' -> 'sega')
                const baseType = Object.keys(KEYMAPS).find(k => type.includes(k));
                map = KEYMAPS[baseType] || KEYMAPS['default'];
            }

            let layout = LAYOUTS[type] || LAYOUTS[Object.keys(LAYOUTS).find(k => type.includes(k))] || LAYOUTS['default'];

            const overlay = document.createElement('div');
            overlay.className = 'vg-overlay';

            // Строим HTML для действий
            let actionsHtml = '';
            layout.actions.forEach(btn => {
                const isYellow = btn === 'A';
                actionsHtml += `<div class="vg-action-btn vg-btn-${btn.toLowerCase()}" data-btn="btn${btn}">${btn}</div>`;
            });

            // Строим HTML для плечевых кнопок
            let shouldersHtml = '';
            if (layout.shoulders.length > 0) {
                shouldersHtml = `
                    <div class="vg-shoulders">
                        <div class="vg-shr-btn" data-btn="btn${layout.shoulders[0]}">${layout.shoulders[0]}</div>
                        <div class="vg-shr-btn" data-btn="btn${layout.shoulders[1]}">${layout.shoulders[1]}</div>
                    </div>
                `;
            }

            // Строим HTML для системных кнопок
            let systemHtml = '';
            if (layout.system.includes('select') && layout.system.includes('start')) {
                systemHtml = `
                    <div class="vg-system">
                        <div class="vg-sys-btn" data-btn="select">SELECT</div>
                        <div class="vg-sys-btn" data-btn="start">START</div>
                    </div>
                `;
            } else if (layout.system.includes('start')) {
                systemHtml = `
                    <div class="vg-system">
                        <div class="vg-sys-btn" data-btn="start">START</div>
                    </div>
                `;
            }

            overlay.innerHTML = `
                <div class="vg-toggle-btn" title="Виртуальный джойстик">🎮</div>
                <div class="vg-pad-container hidden">
                    ${shouldersHtml}
                    <div class="vg-dpad">
                        <div class="vg-dpad-btn vg-dpad-up" data-btn="dpadUp">▲</div>
                        <div class="vg-dpad-btn vg-dpad-down" data-btn="dpadDown">▼</div>
                        <div class="vg-dpad-btn vg-dpad-left" data-btn="dpadLeft">◀</div>
                        <div class="vg-dpad-btn vg-dpad-right" data-btn="dpadRight">▶</div>
                        <div class="vg-dpad-center"></div>
                    </div>
                    <div class="vg-actions ${layout.class}">
                        ${actionsHtml}
                    </div>
                    ${systemHtml}
                </div>
            `;

            container.appendChild(overlay);
            container.style.position = 'relative';

            const padContainer = overlay.querySelector('.vg-pad-container');
            const toggleBtn = overlay.querySelector('.vg-toggle-btn');

            toggleBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                padContainer.classList.toggle('hidden');
                toggleBtn.classList.toggle('active', !padContainer.classList.contains('hidden'));
            });

            // Привязываем обработчики ко всем кнопкам
            const buttons = overlay.querySelectorAll('[data-btn]');
            buttons.forEach(function (el) {
                const action = el.getAttribute('data-btn');
                let keyConfig = map[action];

                // Фолбэк для плечевых кнопок PSX
                if (!keyConfig && action === 'btnL1') keyConfig = map['btnL'];
                if (!keyConfig && action === 'btnR1') keyConfig = map['btnR'];

                if (keyConfig) {
                    bindBtn(el, container, keyConfig);
                } else {
                    el.style.display = 'none'; // Скрываем, если нет маппинга
                }
            });

            instances.set(container, overlay);
        },

        unmount: function (container) {
            if (!container || !instances.has(container)) return;
            const overlay = instances.get(container);
            try { overlay.remove(); } catch (e) {}
            instances.delete(container);
        }
    };
})();