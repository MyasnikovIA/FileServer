/*!
 * jsdos-patch.js v3
 * Патч для js-dos-api.js / js-dos-v3.js:
 *   1) автозапуск игры по имени .jsdos-файла;
 *   2) определение EXE из .jsdos/dosbox.conf (секция [autoexec]) и .jsdos/jsdos.json;
 *   3) сохранение и восстановление save-файлов через IndexedDB
 *      (MEMFS теряет данные при перезагрузке — компенсируем снимками FS).
 *
 * Подключать ПОСЛЕ js-dos-api.js и js-dos-v3.js.
 */
(function () {
  

  if (typeof Dosbox === 'undefined') {
    console.error('[jsdos-patch] Dosbox не найден. Подключите js-dos-api.js раньше.');
    return;
  }

  // ==== Захватываем оригиналы ====
  var OrigDosbox = Dosbox;
  var XhrClass    = OrigDosbox.Xhr;
  var UIClass     = OrigDosbox.UI;
  var ModuleClass = OrigDosbox.Module;
  var MountClass  = OrigDosbox.Mount;
  var origRun     = OrigDosbox.prototype.run;

  if (typeof XhrClass !== 'function') {
    console.error('[jsdos-patch] Dosbox.Xhr не функция. js-dos-api.js загружен?');
    return;
  }

  console.log('[jsdos-patch] Loaded. Xhr=%s UI=%s Module=%s Mount=%s',
    typeof XhrClass, typeof UIClass, typeof ModuleClass, typeof MountClass);

  /* ============================================================
   *  ZIP-утилиты (без внешних зависимостей)
   * ============================================================ */
  var ZipUtil = {
    findEOCD: function (b) {
      for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
        if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
      }
      return -1;
    },
    u16: function (b, o) { return b[o] | (b[o + 1] << 8); },
    u32: function (b, o) {
      return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    },
    listEntries: function (b) {
      var eocd = this.findEOCD(b);
      if (eocd < 0) return [];
      var count = this.u16(b, eocd + 10);
      var off = this.u32(b, eocd + 16);
      var out = [];
      for (var i = 0; i < count; i++) {
        if (this.u32(b, off) !== 0x02014b50) break;
        var nl = this.u16(b, off + 28);
        var el = this.u16(b, off + 30);
        var cl = this.u16(b, off + 32);
        var name = '';
        for (var j = 0; j < nl; j++) name += String.fromCharCode(b[off + 46 + j]);
        out.push({
          name: name,
          method: this.u16(b, off + 10),
          compressedSize: this.u32(b, off + 20),
          uncompressedSize: this.u32(b, off + 24),
          localOffset: this.u32(b, off + 42)
        });
        off += 46 + nl + el + cl;
      }
      return out;
    },
    extractEntry: function (b, e) {
      var local = e.localOffset;
      if (this.u32(b, local) !== 0x04034b50) return Promise.resolve(new Uint8Array(0));
      var nl = this.u16(b, local + 26);
      var el = this.u16(b, local + 28);
      var ds = local + 30 + nl + el;
      var comp = b.subarray(ds, ds + e.compressedSize);
      if (e.method === 0) return Promise.resolve(new Uint8Array(comp));
      if (e.method === 8) {
        if (typeof DecompressionStream === 'undefined') {
          return Promise.reject(new Error('DecompressionStream недоступен'));
        }
        var stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (buf) {
          return new Uint8Array(buf);
        });
      }
      return Promise.reject(new Error('Неподдерживаемый метод ZIP: ' + e.method));
    },
    findEntry: function (entries, path) {
      var norm = path.replace(/^[.\/\\]+/, '').replace(/\\/g, '/').toLowerCase();
      for (var i = 0; i < entries.length; i++) {
        var n = entries[i].name.replace(/^[.\/\\]+/, '').replace(/\\/g, '/').toLowerCase();
        if (n === norm) return entries[i];
      }
      return null;
    },
    bytesToString: function (b) {
      var s = '', chunk = 0x8000;
      for (var i = 0; i < b.length; i += chunk) {
        s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + chunk, b.length)));
      }
      return s;
    }
  };

  /* ============================================================
   *  Парсинг dosbox.conf / jsdos.json
   * ============================================================ */
  function parseAutoexecExecutable(conf) {
    var lines = conf.split(/\r?\n/);
    var inAutoexec = false, candidates = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '[' && line.charAt(line.length - 1) === ']') {
        inAutoexec = line.toLowerCase() === '[autoexec]';
        continue;
      }
      if (!inAutoexec) continue;
      if (line.charAt(0) === '#' || line.charAt(0) === ';') continue;
      var stripped = line.replace(/^@+/, '');
      var m = stripped.match(/^([^\s]+\.(exe|bat|com))\b/i);
      if (m) candidates.push(m[1]);
    }
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function findExecutableByExtension(entries) {
    var c = [];
    for (var i = 0; i < entries.length; i++) {
      var n = entries[i].name;
      if (/^\.jsdos[\/\\]/i.test(n)) continue;
      if (/\.(exe|bat|com)$/i.test(n)) c.push(n);
    }
    if (!c.length) return null;
    c.sort(function (a, b) {
      var ad = (a.match(/[\/\\]/g) || []).length;
      var bd = (b.match(/[\/\\]/g) || []).length;
      return ad !== bd ? ad - bd : a.length - b.length;
    });
    return c[0];
  }

  function detectExecutable(bytes) {
    var entries = ZipUtil.listEntries(bytes);
    if (!entries.length) return Promise.reject(new Error('Не ZIP-архив'));

    var jj = ZipUtil.findEntry(entries, '.jsdos/jsdos.json');
    var p = jj
      ? ZipUtil.extractEntry(bytes, jj).then(function (data) {
          try {
            var cfg = JSON.parse(ZipUtil.bytesToString(data));
            if (cfg && cfg.main) return cfg.main;
          } catch (e) { console.warn('[jsdos-patch] jsdos.json parse:', e.message); }
          return null;
        })
      : Promise.resolve(null);

    return p.then(function (main) {
      if (main) return main;
      var conf = ZipUtil.findEntry(entries, '.jsdos/dosbox.conf');
      if (!conf) return findExecutableByExtension(entries);
      return ZipUtil.extractEntry(bytes, conf).then(function (data) {
        var text = ZipUtil.bytesToString(data);
        var exe = parseAutoexecExecutable(text);
        if (exe) {
          console.log('[jsdos-patch] [autoexec] → ' + exe);
          return exe;
        }
        return findExecutableByExtension(entries);
      });
    });
  }

  /* ============================================================
   *  Утилиты работы с wasm-памятью через ccall (без _malloc)
   * ============================================================ */
  function jsdosMalloc(module, size) {
    if (typeof module.ccall !== 'function') {
      throw new Error('module.ccall недоступен');
    }
    // ccall('malloc') находит функцию через Module["_malloc"] || eval("_malloc")
    return module.ccall('malloc', 'number', ['number'], [size]);
  }
  function jsdosFree(module, ptr) {
    try { module.ccall('free', 'void', ['number'], [ptr]); }
    catch (e) { console.warn('[jsdos-patch] free fail:', e); }
  }
  function jsdosGetHeap(module) {
    if (module.HEAPU8) return module.HEAPU8;
    if (module.HEAP8) return new Uint8Array(module.HEAP8.buffer);
    if (module.buffer) return new Uint8Array(module.buffer);
    return null;
  }
  function jsdosWriteBytes(module, ptr, bytes) {
    var heap = jsdosGetHeap(module);
    if (!heap) throw new Error('HEAPU8/buffer не найден');
    heap.set(bytes, ptr);
  }

  /* ============================================================
   *  SaveManager — IndexedDB + снапшоты MEMFS
   * ============================================================ */
  var SaveManager = {
    DB_NAME: 'jsdos-saves-v1',
    STORE: 'files',
    AUTO_SAVE_MS: 2000,
    MAX_FILE_SIZE: 5 * 1024 * 1024,

    module: null,
    FS: null,
    shippedBaseline: null,
    saveKey: null,
    _dbPromise: null,
    _timer: null,
    _lastSavedState: null,
    _hooked: false,

    init: function (module, saveKey) {
      this.module = module;
      this.saveKey = saveKey || 'default';
      this.FS = this._findFS(module);
      if (!this.FS) {
        console.error('[saves] FS недоступен — сохранения отключены.');
        console.log('[saves] module keys:', Object.keys(module).slice(0, 40));
        return false;
      }
      console.log('[saves] FS найден. saveKey=' + this.saveKey);
      return true;
    },

    _findFS: function (m) {
      if (m.FS && typeof m.FS.readdir === 'function') return m.FS;
      if (m['FS'] && typeof m['FS'].readdir === 'function') return m['FS'];
      if (typeof m.FS_readdir === 'function' && typeof m.FS_readFile === 'function') {
        return {
          readdir: m.FS_readdir,
          readFile: m.FS_readFile,
          writeFile: m.FS_writeFile,
          stat: m.FS_stat,
          mkdir: m.FS_mkdir,
          isDir: function (mode) { return (mode & 0x4000) !== 0; }
        };
      }
      try { if (typeof FS !== 'undefined' && FS.readdir) return FS; } catch (e) {}
      try { if (window.FS && window.FS.readdir) return window.FS; } catch (e) {}
      return null;
    },

    _snapshot: function () {
      var FS = this.FS, self = this, result = {};
      function walk(dir) {
        var entries;
        try { entries = FS.readdir(dir); } catch (e) { return; }
        for (var i = 0; i < entries.length; i++) {
          var name = entries[i];
          if (name === '.' || name === '..') continue;
          var full = (dir === '/' ? '' : dir) + '/' + name;
          try {
            var st = FS.stat(full);
            if (FS.isDir(st.mode)) {
              if (self._isSysPath(full)) continue;
              walk(full);
            } else {
              result[full] = { mtime: st.mtime ? +st.mtime : 0, size: st.size || 0 };
            }
          } catch (e) { /* skip */ }
        }
      }
      walk('/');
      return result;
    },

    _isSysPath: function (p) {
      return /^\/(dev|proc|sys|tmp)\//.test(p) ||
             /^\/\.jsdos\//.test(p) ||
             /^\/home\/web_user\//.test(p) ||
             /^\/lib\//.test(p) ||
             /^\/usr\//.test(p);
    },

    _dirOf: function (p) {
      var i = p.lastIndexOf('/');
      return i <= 0 ? '/' : p.substring(0, i);
    },

    _ensureDir: function (dir) {
      if (!dir || dir === '/') return;
      var parts = dir.split('/').filter(Boolean), cur = '';
      for (var i = 0; i < parts.length; i++) {
        cur += '/' + parts[i];
        try { this.FS.mkdir(cur); } catch (e) { /* already exists */ }
      }
    },

    captureShippedBaseline: function () {
      if (!this.FS) return;
      this.shippedBaseline = this._snapshot();
      console.log('[saves] baseline: ' + Object.keys(this.shippedBaseline).length + ' файлов');
    },

    _collectSavePaths: function (current) {
      var out = [];
      for (var p in current) {
        if (this._isSysPath(p)) continue;
        if (current[p].size > this.MAX_FILE_SIZE) continue;
        if (/\.(tmp|log|lock|pid)$/i.test(p)) continue;
        var base = this.shippedBaseline[p];
        if (base && base.mtime === current[p].mtime && base.size === current[p].size) continue;
        out.push(p);
      }
      return out;
    },

    _hasChanges: function (prev, curr) {
      for (var p in curr) {
        if (!(p in prev)) return true;
        if (prev[p].mtime !== curr[p].mtime || prev[p].size !== curr[p].size) return true;
      }
      for (var q in prev) if (!(q in curr)) return true;
      return false;
    },

    save: function () {
      if (!this.FS || !this.shippedBaseline) return Promise.resolve(0);
      var current = this._snapshot();
      if (this._lastSavedState && !this._hasChanges(this._lastSavedState, current)) {
        return Promise.resolve(0);
      }
      var paths = this._collectSavePaths(current);
      var records = [];
      for (var i = 0; i < paths.length; i++) {
        try { records.push({ path: paths[i], data: this.FS.readFile(paths[i]) }); }
        catch (e) { console.warn('[saves] read fail:', paths[i], e); }
      }
      var self = this;
      console.log('[saves] сохранение ' + records.length + ' файлов');
      return this._writeAll(records).then(function () {
        self._lastSavedState = current;
        return records.length;
      });
    },

    restore: function () {
      if (!this.FS) return Promise.resolve(0);
      var self = this;
      return this._readAll().then(function (records) {
        var n = 0;
        records.forEach(function (r) {
          try {
            self._ensureDir(self._dirOf(r.path));
            // Конвертируем данные в Uint8Array (на случай, если из IDB пришёл ArrayBuffer)
            var data = new Uint8Array(r.data);
            
            // Открываем поток на запись ('w' или 'wb')
            var stream = self.FS.open(r.path, 'w');
            // Пишем ровно data.length байт
            self.FS.write(stream, data, 0, data.length, 0, true);
            self.FS.close(stream);
            
            n++;
          } catch (e) { console.warn('[saves] restore fail:', r.path, e); }
        });
        console.log('[saves] восстановлено ' + n + ' файлов');
        return n;
      });
    },

    /* ---------- IndexedDB ---------- */
    _openDB: function () {
      if (this._dbPromise) return this._dbPromise;
      var self = this;
      this._dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open(self.DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(self.STORE)) {
            db.createObjectStore(self.STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function (e) { reject(e.target.error); };
      });
      return this._dbPromise;
    },

    _readAll: function () {
      var self = this;
      return this._openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction([self.STORE], 'readonly');
          var req = tx.objectStore(self.STORE).openCursor();
          var out = [];
          req.onsuccess = function (e) {
            var cur = e.target.result;
            if (!cur) { resolve(out); return; }
            if (cur.value.gameKey === self.saveKey) out.push(cur.value);
            cur.continue();
          };
          req.onerror = function () { reject(req.error); };
        });
      });
    },

    _writeAll: function (records) {
      var self = this;
      return this._openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction([self.STORE], 'readwrite');
          var store = tx.objectStore(self.STORE);
          var req = store.openCursor();
          req.onsuccess = function (e) {
            var cur = e.target.result;
            if (cur) {
              if (cur.value.gameKey === self.saveKey) cur.delete();
              cur.continue();
            } else {
              records.forEach(function (r) {
                store.put({
                  key: self.saveKey + '::' + r.path,
                  gameKey: self.saveKey,
                  path: r.path,
                  data: r.data
                });
              });
            }
          };
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(new Error('tx aborted')); };
        });
      });
    },

    /* ---------- автосохранение ---------- */
    startAutoSave: function () {
      if (this._hooked) return;
      this._hooked = true;
      var self = this;

      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(function () {
        self.save().catch(function (e) { console.warn('[saves] auto-save:', e); });
      }, this.AUTO_SAVE_MS);

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) self.save().catch(function () {});
      });
      window.addEventListener('pagehide', function () {
        self.save().catch(function () {});
      });
      window.addEventListener('beforeunload', function () {
        self.save().catch(function () {});
      });

      window.addEventListener('keydown', function (e) {
        var mod = e.ctrlKey || e.metaKey;
        if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          self.save().then(function (n) {
            console.log('[saves] ручное сохранение: ' + n + ' файлов');
          }).catch(function () {});
        }
        if (mod && e.shiftKey && (e.key === 'S' || e.key === 's')) {
          e.preventDefault();
          self.exportToFile().catch(function (err) { console.error('[saves] export:', err); });
        }
        if (mod && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
          e.preventDefault();
          self.importFromFile().catch(function (err) { console.error('[saves] import:', err); });
        }
      });

      console.log('[saves] автосохранение каждые ' + this.AUTO_SAVE_MS +
        ' мс. Ctrl+S=save, Ctrl+Shift+S=export, Ctrl+Shift+O=import');
    },

    stopAutoSave: function () {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    /* ---------- экспорт/импорт ---------- */
    exportToFile: function () {
      var self = this;
      return this._readAll().then(function (records) {
        var payload = {
          version: 1,
          saveKey: self.saveKey,
          exportedAt: new Date().toISOString(),
          files: records.map(function (r) {
            return { path: r.path, data: Array.prototype.slice.call(r.data) };
          })
        };
        var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (self.saveKey.replace(/[^a-z0-9]/gi, '_') || 'saves') + '.jsdos-save.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
        console.log('[saves] экспортировано ' + records.length + ' файлов');
      });
    },

    importFromFile: function () {
      var self = this;
      return new Promise(function (resolve, reject) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.jsdos-save.json';
        input.onchange = function () {
          var f = input.files[0];
          if (!f) { reject(new Error('файл не выбран')); return; }
          var rd = new FileReader();
          rd.onload = function () {
            try {
              var payload = JSON.parse(rd.result);
              if (!payload.files || !Array.isArray(payload.files)) throw new Error('неверный формат');
              var records = payload.files.map(function (x) {
                return { path: x.path, data: new Uint8Array(x.data) };
              });
              self._writeAll(records)
                .then(function () { return self.restore(); })
                .then(function (n) { console.log('[saves] импортировано ' + n); resolve(n); })
                .catch(reject);
            } catch (e) { reject(e); }
          };
          rd.onerror = function () { reject(rd.error); };
          rd.readAsText(f);
        };
        input.click();
      });
    }
  };

  /* ============================================================
   *  Патч _jsdos_init
   *
   *  Запускаем скрипт js-dos-v3.js через Function-конструктор:
   *    - new Function(...) создаёт ИЗОЛИРОВАННЫЙ не-strict scope,
   *      независимо от 'use strict' во внешнем IIFE;
   *    - Module передаётся параметром, и `var Module;` в начале
   *      js-dos-v3.js — это повторное объявление ТОЙ ЖЕ привязки
   *      (hoisting), а не новая переменная. Поэтому все записи
   *      Module.FS/_malloc/... попадают в наш объект.
   * ============================================================ */
  OrigDosbox.prototype._jsdos_init = function (module, script, onload) {
    var inject =
      '\n;(function(){try{' +
      'if(typeof FS!=="undefined")     Module.FS     = FS;' +
      'if(typeof _malloc!=="undefined")Module._malloc= _malloc;' +
      'if(typeof _free!=="undefined")  Module._free  = _free;' +
      'if(typeof ccall!=="undefined")  Module.ccall  = ccall;' +
      'if(typeof cwrap!=="undefined")  Module.cwrap  = cwrap;' +
      'if(typeof HEAPU8!=="undefined") Module.HEAPU8 = HEAPU8;' +
      'if(typeof HEAP8!=="undefined")  Module.HEAP8  = HEAP8;' +
      'if(typeof HEAP32!=="undefined") Module.HEAP32 = HEAP32;' +
      'if(typeof buffer!=="undefined") Module.buffer = buffer;' +
      'console.log("[saves] inject: canvas=" + (Module.canvas?"ok":"MISSING") +' +
      '" FS=" + (typeof Module.FS) +' +
      '" _malloc=" + (typeof Module._malloc) +' +
      '" _free=" + (typeof Module._free) +' +
      '" ccall=" + (typeof Module.ccall) +' +
      '" HEAPU8=" + (typeof Module.HEAPU8));' +
      '}catch(e){console.warn("[saves] inject error:", e);}})();';

    // Function-конструктор: тело всегда не-strict (пока само не начнётся с 'use strict',
    // а js-dos-v3.js начинается с `var Module;`). Параметр Module = наш target.
    var runner = new Function('Module', script + inject);
    runner.call(window, module);

    console.log('[saves] after eval: canvas=%s FS=%s ccall=%s HEAPU8=%s _malloc=%s _free=%s',
      module.canvas ? 'ok' : 'MISSING',
      typeof module.FS,
      typeof module.ccall,
      typeof module.HEAPU8,
      typeof module._malloc,
      typeof module._free);

    if (onload) return onload(this);
  };

  /* ============================================================
   *  Патч run — EXE из конфига + save persistence
   * ============================================================ */
  OrigDosbox.prototype.run = function (archiveUrl, executable) {
    if (executable) return origRun.call(this, archiveUrl, executable);

    var self = this;
    var persist = this._persistSaves !== false;

    self.ui.updateMessage('Downloading ' + archiveUrl);

    return new XhrClass(archiveUrl, {
      success: function (data) {
        var bytes;
        if (typeof data === 'string') {
          bytes = new Uint8Array(data.length);
          for (var i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xFF;
        } else if (data instanceof Uint8Array) {
          bytes = data;
        } else {
          bytes = new Uint8Array(data);
        }
        console.log('[jsdos-patch] downloaded ' + bytes.length + ' bytes');

        detectExecutable(bytes).then(function (exe) {
          if (!exe) {
            console.error('[jsdos-patch] не удалось найти EXE');
            self.ui.updateMessage('EXE не найден');
            return;
          }
          console.log('[jsdos-patch] launch: ' + exe);

          // --- extract_zip через ccall('malloc'/'free'), без _malloc на Module ---
          var buffer;
          try {
            buffer = jsdosMalloc(self.module, bytes.length);
          } catch (e) {
            console.error('[jsdos-patch] malloc fail:', e);
            self.ui.updateMessage('Ошибка malloc');
            return;
          }
          try {
            jsdosWriteBytes(self.module, buffer, bytes);
          } catch (e) {
            console.error('[jsdos-patch] write HEAP fail:', e);
            jsdosFree(self.module, buffer);
            self.ui.updateMessage('Ошибка записи в память');
            return;
          }

          var rc;
          try {
            rc = self.module.ccall('extract_zip', 'int',
              ['number', 'number'], [buffer, bytes.length]);
          } catch (e) {
            console.error('[jsdos-patch] extract_zip exception:', e);
            jsdosFree(self.module, buffer);
            self.ui.updateMessage('Ошибка extract_zip');
            return;
          }
          jsdosFree(self.module, buffer);

          if (rc !== 0) {
            console.error('[jsdos-patch] extract_zip rc=' + rc);
            self.ui.updateMessage('Ошибка распаковки (rc=' + rc + ')');
            return;
          }

          // --- save persistence ---
          if (persist && SaveManager.init(self.module, archiveUrl)) {
            SaveManager.captureShippedBaseline();
            SaveManager.restore().then(function (n) {
              if (n > 0) self.ui.updateMessage('Восстановлено ' + n + ' save-файл(ов)');
              startGame();
            }).catch(function (e) {
              console.warn('[saves] restore:', e);
              startGame();
            });
          } else {
            startGame();
          }

          function startGame() {
            self.ui.updateMessage('Launching ' + exe);
            setTimeout(function () {
              try { self._dosbox_main(self, exe); }
              catch (e) { console.error('[jsdos-patch] dosbox_main:', e); }
            }, 1000);
            setTimeout(function () { self.ui.hideLoader(); }, 3000);
            if (persist) SaveManager.startAutoSave();
          }
        }).catch(function (err) {
          console.error('[jsdos-patch]', err);
          self.ui.updateMessage('Ошибка: ' + (err && err.message ? err.message : err));
        });
      },
      progress: function (total, current) {
        if (total > 0) {
          self.ui.updateMessage('Downloading ' + archiveUrl +
            ' (' + Math.floor(current * 100 / total) + '%)');
        }
      }
    });
  };

  /* ============================================================
   *  Патч конструктора + статика
   * ============================================================ */
  function PatchedDosbox(options) {
    options = options || {};
    this._persistSaves = options.persistSaves !== false;

    if (options.file) {
      var userOnload = options.onload;
      var fileRun = false;
      options.onload = function (dosbox) {
        if (userOnload) userOnload(dosbox);
        if (!fileRun) { fileRun = true; dosbox.run(options.file); }
      };
    }

    OrigDosbox.call(this, options);

    if (options.autoStart) {
      var self = this;
      setTimeout(function () {
        if (self.ui && self.ui.start) self.ui.start.click();
      }, 0);
    }
  }

  PatchedDosbox.prototype = OrigDosbox.prototype;

  for (var k in OrigDosbox) {
    if (Object.prototype.hasOwnProperty.call(OrigDosbox, k)) {
      PatchedDosbox[k] = OrigDosbox[k];
    }
  }
  PatchedDosbox.Xhr    = XhrClass;
  PatchedDosbox.UI     = UIClass;
  PatchedDosbox.Module = ModuleClass;
  PatchedDosbox.Mount  = MountClass;
  PatchedDosbox.SaveManager = SaveManager;

  window.Dosbox = PatchedDosbox;

  console.log('[jsdos-patch] Installed. new Dosbox({ file: "game.jsdos", autoStart: true })');
})();