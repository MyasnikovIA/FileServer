// ============================================================
// 60-virtual-gamepad.js — Виртуальный джойстик для эмуляторов
// ============================================================

FAR.VirtualGamepad = (function () {
    const KEYMAPS = {
        // Nintendo Entertainment System (JSNES)
        'nes': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'x',          code: 'KeyX',       keyCode: 88 },
            btnB:      { key: 'z',          code: 'KeyZ',       keyCode: 90 },
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
            select:    { key: 'Control',    code: 'ControlRight', keyCode: 17 }
        },
        // DOSBox (JSDOS)
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
        // EmulatorJS (GBA, SNES, PSX и др.)
        'emulator': {
            dpadUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
            dpadDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
            dpadLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
            dpadRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
            btnA:      { key: 'x',          code: 'KeyX',       keyCode: 88 },
            btnB:      { key: 'z',          code: 'KeyZ',       keyCode: 90 },
            btnX:      { key: 's',          code: 'KeyS',       keyCode: 83 },
            btnY:      { key: 'a',          code: 'KeyA',       keyCode: 65 },
            start:     { key: 'Enter',      code: 'Enter',      keyCode: 13 },
            select:    { key: 'Shift',      code: 'ShiftLeft',  keyCode: 16 }
        }
    };

    const instances = new WeakMap();

    /**
     * Отправляет событие клавиатуры в окно, документ и canvas.
     */
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

        // Отправляем на сам контейнер и на canvas внутри него
        container.dispatchEvent(ev);

        const canvas = container.querySelector('canvas');
        if (canvas) {
            try { canvas.dispatchEvent(ev); } catch(e){}
        }

        // На всякий случай отправляем глобально
        document.dispatchEvent(ev);
        window.dispatchEvent(ev);
    }

    /**
     * Создает кнопку с обработчиками.
     */
    function bindBtn(el, container, keyConfig) {
        if (!keyConfig) {
            el.style.display = 'none';
            return;
        }

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
         * Монтирует джойстик в контейнер эмулятора.
         * @param {HTMLElement} container — корневой элемент эмулятора
         * @param {string} type — 'nes' | 'jsdos' | 'emulator'
         */
        mount: function (container, type) {
            if (!container || instances.has(container)) return;
            const map = KEYMAPS[type] || KEYMAPS['emulator'];

            const overlay = document.createElement('div');
            overlay.className = 'vg-overlay';
            overlay.innerHTML = `
                <div class="vg-toggle-btn" title="Виртуальный джойстик">🎮</div>
                <div class="vg-pad-container hidden">
                    <div class="vg-dpad">
                        <div class="vg-dpad-btn vg-dpad-up" data-btn="dpadUp">▲</div>
                        <div class="vg-dpad-btn vg-dpad-down" data-btn="dpadDown">▼</div>
                        <div class="vg-dpad-btn vg-dpad-left" data-btn="dpadLeft">◀</div>
                        <div class="vg-dpad-btn vg-dpad-right" data-btn="dpadRight">▶</div>
                        <div class="vg-dpad-center"></div>
                    </div>
                    <div class="vg-actions">
                        <div class="vg-action-btn vg-btn-x" data-btn="btnX">X</div>
                        <div class="vg-action-btn vg-btn-y" data-btn="btnY">Y</div>
                        <div class="vg-action-btn vg-btn-a" data-btn="btnA">A</div>
                        <div class="vg-action-btn vg-btn-b" data-btn="btnB">B</div>
                    </div>
                    <div class="vg-system">
                        <div class="vg-sys-btn" data-btn="select">SELECT</div>
                        <div class="vg-sys-btn" data-btn="start">START</div>
                    </div>
                </div>
            `;

            container.appendChild(overlay);
            container.style.position = 'relative'; // Чтобы absolute позиционировалось верно

            const padContainer = overlay.querySelector('.vg-pad-container');
            const toggleBtn = overlay.querySelector('.vg-toggle-btn');

            toggleBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                padContainer.classList.toggle('hidden');
                toggleBtn.classList.toggle('active', !padContainer.classList.contains('hidden'));
            });

            const buttons = overlay.querySelectorAll('[data-btn]');
            buttons.forEach(function (el) {
                const action = el.getAttribute('data-btn');
                const keyConfig = map[action];
                bindBtn(el, container, keyConfig);
            });

            instances.set(container, overlay);
        },

        /**
         * Удаляет джойстик и снимает обработчики.
         * @param {HTMLElement} container
         */
        unmount: function (container) {
            if (!container || !instances.has(container)) return;
            const overlay = instances.get(container);
            try { overlay.remove(); } catch (e) {}
            instances.delete(container);
        }
    };
})();