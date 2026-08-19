/* charts.js — hand-rolled canvas line charts with fluid LERP smoothing.
   Every animation frame the displayed values ease toward their targets,
   so live ticks glide instead of jumping. No external libraries. */
(function (global) {
  'use strict';

  /* Ceil to a "nice" round number so grid labels stay readable. */
  function niceMax(v) {
    if (!isFinite(v) || v <= 0) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / pow;
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) {
      if (n <= steps[i]) return steps[i] * pow;
    }
    return 10 * pow;
  }

  function fmtCompact(v) {
    if (v >= 10000) return Math.round(v / 1000) + 'k';
    if (v >= 1000) return (v / 1000).toFixed(1).replace('.', ',') + 'k';
    if (v % 1 !== 0) return v.toFixed(1).replace('.', ',');
    return String(Math.round(v));
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  var PAD = { l: 40, r: 10, t: 12, b: 22 };

  /**
   * SmoothChart
   * opts: {
   *   color:   css color of the line
   *   unit:    '%' | 'MB' | '' ... (tooltip suffix)
   *   max:     number | (dataMax)=>number   (default: auto niceMax)
   *   windowMs: rolling time window (default 60min)
   *   live:    draw a pulsing dot at the newest point
   * }
   */
  function SmoothChart(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.color = this.opts.color || '#8dff57';
    this.unit = this.opts.unit || '';
    this.windowMs = this.opts.windowMs || 60 * 60 * 1000;
    this.points = [];   // [{ts, v}]   target values
    this.disp = [];     // [v]         displayed (lerped) values
    this.hover = -1;
    this.pulse = 0;
    this._raf = null;
    this._lastFrame = 0;
    this.ctx = canvas.getContext('2d');

    // tooltip element lives next to the canvas
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip hidden';
    if (canvas.parentElement) canvas.parentElement.appendChild(this.tip);

    this._onMove = this._handleMove.bind(this);
    this._onLeave = this._handleLeave.bind(this);
    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);

    var self = this;
    this._ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(function () { self._resize(); }) : null;
    if (this._ro && canvas.parentElement) this._ro.observe(canvas.parentElement);
    this._resize();
  }

  SmoothChart.prototype._resize = function () {
    var holder = this.canvas.parentElement;
    if (!holder) return;
    var w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    var dpr = global.devicePixelRatio || 1;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  };

  /* Full replacement (history load). Renders immediately, no grow-in from 0. */
  SmoothChart.prototype.setData = function (points) {
    this.points = points.slice();
    this.disp = points.map(function (p) { return p.v; });
    this._prune();
  };

  /* Append one live tick. The new display value starts at the previous
     displayed value so the line never teleports. */
  SmoothChart.prototype.push = function (p) {
    // ignore out-of-order duplicates
    if (this.points.length && p.ts <= this.points[this.points.length - 1].ts) {
      this.points[this.points.length - 1] = p;
      return;
    }
    this.points.push(p);
    var last = this.disp.length ? this.disp[this.disp.length - 1] : p.v;
    this.disp.push(last);
    this._prune();
  };

  SmoothChart.prototype._prune = function () {
    var cutoff = Date.now() - this.windowMs;
    var drop = 0;
    while (drop < this.points.length && this.points[drop].ts < cutoff) drop++;
    if (drop > 0) {
      this.points.splice(0, drop);
      this.disp.splice(0, drop);
    }
  };

  SmoothChart.prototype._maxY = function () {
    var m = this.opts.max;
    var dataMax = 0;
    for (var i = 0; i < this.points.length; i++) if (this.points[i].v > dataMax) dataMax = this.points[i].v;
    if (typeof m === 'function') return Math.max(1, m(dataMax));
    if (typeof m === 'number') return m;
    return niceMax(dataMax * 1.15);
  };

  SmoothChart.prototype._handleMove = function (ev) {
    var rect = this.canvas.getBoundingClientRect();
    var x = ev.clientX - rect.left;
    var plotW = this.w - PAD.l - PAD.r;
    if (!this.points.length || plotW <= 0) { this.hover = -1; return; }
    var now = Date.now();
    var t0 = now - this.windowMs;
    var ts = t0 + ((x - PAD.l) / plotW) * this.windowMs;
    // nearest point
    var best = -1, bestD = Infinity;
    for (var i = 0; i < this.points.length; i++) {
      var d = Math.abs(this.points[i].ts - ts);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.hover = best;
  };

  SmoothChart.prototype._handleLeave = function () {
    this.hover = -1;
    this.tip.classList.add('hidden');
  };

  SmoothChart.prototype.start = function () {
    if (this._raf) return;
    var self = this;
    this._lastFrame = performance.now();
    var loop = function (now) {
      self._raf = requestAnimationFrame(loop);
      var dt = Math.min(100, now - self._lastFrame);
      self._lastFrame = now;
      self._tick(dt);
    };
    this._raf = requestAnimationFrame(loop);
  };

  SmoothChart.prototype.stop = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  };

  SmoothChart.prototype.destroy = function () {
    this.stop();
    if (this._ro) this._ro.disconnect();
    this.canvas.removeEventListener('mousemove', this._onMove);
    this.canvas.removeEventListener('mouseleave', this._onLeave);
    if (this.tip && this.tip.parentElement) this.tip.parentElement.removeChild(this.tip);
  };

  SmoothChart.prototype._tick = function (dt) {
    // frame-rate independent smoothing factor (~90ms time constant)
    var k = 1 - Math.exp(-dt / 90);
    for (var i = 0; i < this.disp.length; i++) {
      var target = this.points[i] ? this.points[i].v : 0;
      this.disp[i] += (target - this.disp[i]) * k;
    }
    this.pulse += dt;
    this._draw();
  };

  SmoothChart.prototype._draw = function () {
    var ctx = this.ctx, w = this.w, h = this.h;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    var plotW = w - PAD.l - PAD.r, plotH = h - PAD.t - PAD.b;
    var maxY = this._maxY();
    var now = Date.now();
    var t0 = now - this.windowMs;

    var self = this;
    function xOf(ts) { return PAD.l + ((ts - t0) / self.windowMs) * plotW; }
    function yOf(v) { return PAD.t + plotH - (Math.min(v, maxY) / maxY) * plotH; }

    /* grid + y labels */
    ctx.font = '9px "Inter", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    var rows = 4;
    for (var g = 0; g <= rows; g++) {
      var gy = PAD.t + (plotH / rows) * g;
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.l, gy + 0.5);
      ctx.lineTo(w - PAD.r, gy + 0.5);
      ctx.stroke();
      var val = maxY * (1 - g / rows);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.textAlign = 'right';
      ctx.fillText(fmtCompact(val), PAD.l - 6, gy);
    }

    /* x time labels (every 1/5 of the window) */
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (var s = 0; s <= 5; s++) {
      var ts = t0 + (this.windowMs / 5) * s;
      ctx.fillText(fmtTime(ts), xOf(ts), h - PAD.b / 2);
    }

    if (!this.points.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.textAlign = 'center';
      ctx.fillText('warte auf Daten …', PAD.l + plotW / 2, PAD.t + plotH / 2);
      return;
    }

    /* smooth path through displayed values */
    ctx.beginPath();
    var firstX = xOf(this.points[0].ts), lastX = firstX;
    for (var i = 0; i < this.points.length; i++) {
      var px = xOf(this.points[i].ts);
      var py = yOf(this.disp[i]);
      lastX = px;
      if (i === 0) ctx.moveTo(px, py);
      else {
        // midpoint quadratic for extra smoothness
        var prevX = xOf(this.points[i - 1].ts);
        var prevY = yOf(this.disp[i - 1]);
        var mx = (prevX + px) / 2, my = (prevY + py) / 2;
        ctx.quadraticCurveTo(prevX, prevY, mx, my);
      }
    }
    ctx.lineTo(lastX, yOf(this.disp[this.disp.length - 1]));

    /* gradient area fill */
    var grad = ctx.createLinearGradient(0, PAD.t, 0, h - PAD.b);
    grad.addColorStop(0, this._alpha(this.color, 0.30));
    grad.addColorStop(1, this._alpha(this.color, 0));
    ctx.save();
    ctx.lineTo(lastX, h - PAD.b);
    ctx.lineTo(firstX, h - PAD.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    /* glowing stroke */
    ctx.beginPath();
    for (var j = 0; j < this.points.length; j++) {
      var jx = xOf(this.points[j].ts);
      var jy = yOf(this.disp[j]);
      if (j === 0) ctx.moveTo(jx, jy);
      else {
        var qx = xOf(this.points[j - 1].ts);
        var qy = yOf(this.disp[j - 1]);
        ctx.quadraticCurveTo(qx, qy, (qx + jx) / 2, (qy + jy) / 2);
      }
    }
    ctx.lineTo(lastX, yOf(this.disp[this.disp.length - 1]));
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    /* pulsing live dot */
    if (this.opts.live && this.points.length) {
      var lx = xOf(this.points[this.points.length - 1].ts);
      var ly = yOf(this.disp[this.disp.length - 1]);
      var r = 3 + Math.sin(this.pulse / 300) * 1.2;
      ctx.beginPath();
      ctx.arc(lx, ly, Math.max(1.5, r), 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    /* hover crosshair + tooltip */
    if (this.hover >= 0 && this.hover < this.points.length) {
      var hp = this.points[this.hover];
      var hx = xOf(hp.ts), hy = yOf(this.disp[this.hover]);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, PAD.t);
      ctx.lineTo(hx, h - PAD.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 2;
      ctx.stroke();

      this.tip.textContent = fmtTime(hp.ts) + '  ·  ' + fmtCompact(hp.v) + (this.unit ? ' ' + this.unit : '');
      this.tip.classList.remove('hidden');
      var tipX = Math.min(Math.max(hx, 50), this.w - 60);
      this.tip.style.left = tipX + 'px';
      this.tip.style.top = Math.max(2, hy - 34) + 'px';
    } else {
      this.tip.classList.add('hidden');
    }
  };

  SmoothChart.prototype._alpha = function (hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };

  /* Animate a number element toward a new value with ease-out cubic. */
  function countUp(el, to, opts) {
    opts = opts || {};
    var dur = opts.duration || 650;
    var fmt = opts.format || function (v) { return String(Math.round(v)); };
    var from = (typeof el._cv === 'number') ? el._cv : 0;
    if (from === to) { el.textContent = fmt(to); return; }
    el._cv = to;
    if (el._cuRaf) cancelAnimationFrame(el._cuRaf);
    var t0 = performance.now();
    var step = function (now) {
      var p = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      var v = from + (to - from) * e;
      el.textContent = fmt(p === 1 ? to : v);
      if (p < 1) el._cuRaf = requestAnimationFrame(step);
    };
    el._cuRaf = requestAnimationFrame(step);
  }

  global.Charts = { SmoothChart: SmoothChart, countUp: countUp, niceMax: niceMax, fmtCompact: fmtCompact, fmtTime: fmtTime };
})(typeof window !== 'undefined' ? window : globalThis);
