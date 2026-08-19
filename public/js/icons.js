/* icons.js — Pixel-art SVG icon library (16x16 grids, crisp edges).
   Usage: Icons.get('grass')  -> svg string
          Icons.ui('play')   -> svg string tinted with currentColor
          window.Icons is the single entry point. */
(function (global) {
  'use strict';

  // Build an SVG string from a 16x16 char map + palette ('.' = transparent).
  // Horizontal runs of equal color are merged into one rect to keep the DOM small.
  function px(map, palette) {
    var rects = [];
    for (var y = 0; y < map.length; y++) {
      var row = map[y];
      var x = 0;
      while (x < row.length) {
        var ch = row[x];
        if (ch === '.') { x++; continue; }
        var run = 1;
        while (x + run < row.length && row[x + run] === ch) run++;
        rects.push('<rect x="' + x + '" y="' + y + '" width="' + run + '" height="1" fill="' + palette[ch] + '"/>');
        x += run;
      }
    }
    return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + rects.join('') + '</svg>';
  }

  var MAPS = {};

  /* ------------------------------ BLOCKS / ITEMS ------------------------------ */

  MAPS.grass = {
    pal: { G: '#7ed957', g: '#55a02f', D: '#8a5f3c', d: '#6b4527' },
    map: [
      'GGGGGGGGGGGGGGGG',
      'GggggggggggggggG',
      'ggggGGgggggGGggg',
      'gggggggggggggggg',
      'gggGggggggGggggg',
      'DgDggggDggggggDg',
      'DDDDDDgDDDgDDDDD',
      'DdDDDDDDDDDDDDDD',
      'DDDDDdDDDDDdDDDD',
      'DDDDDDDDDDDDDDDD',
      'DdDDDdDDdDDDDdDD',
      'DDDDDDDDDDDDDDDD',
      'DDDDdDDDDdDDDDDD',
      'DDDDDDdDDDdDDDDD',
      'dDDDDDDDDDDDDDdD',
      'DDDDDDDDDDDDDDDD'
    ]
  };

  MAPS.dirt = {
    pal: { D: '#8a5f3c', d: '#6b4527' },
    map: [
      'DDDDDDDDDDDDDDDD',
      'DdDDDDdDDDDdDDDD',
      'DDDDDDDDDDDDDDDD',
      'DDDDdDDDdDDDDDdD',
      'DDDDDDDDDDDDDDDD',
      'DdDDDDDDDDDdDDDD',
      'DDDDDDDDDDDDDDDD',
      'DDDDdDDdDDDDDDDD',
      'DDDDDDDDDDDDDDDD',
      'dDDDDDDdDDDDdDDd',
      'DDDDDDDDDDDDDDDD',
      'DDdDDdDDDDDDDdDD',
      'DDDDDDDDDDDDDDDD',
      'DDDDdDDDDDDdDDDD',
      'DDDDDDDDDDDDDDDD',
      'DdDDDdDDDdDDDdDD'
    ]
  };

  MAPS.diamond = {
    pal: { '#': '#0d4b5c', a: '#3fd8ea', A: '#8ff5fd', W: '#eafeff' },
    map: [
      '................',
      '................',
      '....########....',
      '...#aaaaaaaa#...',
      '..#aWAaaaaaaa#..',
      '..#aaaaaaaaaa#..',
      '...#aaaaaaaa#...',
      '....#aaaaaa#....',
      '.....#aaaa#.....',
      '......#aa#......',
      '.......##.......',
      '................',
      '................',
      '................',
      '................',
      '................'
    ]
  };

  MAPS.diamond_ore = {
    pal: { S: '#828282', s: '#666666', a: '#4fe3ee', A: '#9bf7ff' },
    map: [
      'SSSSSSSSSSSSSSSS',
      'SsSSSSSsSSSSSsSS',
      'SSSaaSSSSSSSSSSS',
      'SSaAaASSSSSsSSSS',
      'SSSaaSSSSSSSSSSS',
      'SSSSSSSSaaSSSSSS',
      'SsSSSSSaAaASSsSS',
      'SSSSSSSSaaSSSSSS',
      'SSSSSSSSSSSSSSSS',
      'SSaaSSSSSSSaaSSS',
      'SaAaASSSSSaAaASS',
      'SSaaSSSSSSSaaSSS',
      'SSSSSSsSSSSSSSSS',
      'SSSSSSSSSSaaSSSS',
      'SsSSSsSSSSaAaASS',
      'SSSSSSSSSSSaaSSS'
    ]
  };

  MAPS.redstone = {
    pal: { r: '#e0301c', R: '#9e1608', W: '#ff9a8a' },
    map: [
      '................',
      '.....r....r.....',
      '...r.Rr..rR.r...',
      '..rR.rRrRr.Rr...',
      '...rRRRRRRRr....',
      '..rRRWRRRWRRr...',
      '.rRRRRRRRRRRRr..',
      '.rRWRRRRRRWRRr..',
      '..rRRRRRRRRRr...',
      '....rrrrrrr.....',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ]
  };

  MAPS.tnt = {
    pal: { K: '#2a0d08', R: '#d43a26', r: '#a12716', W: '#e8e4da', w: '#b9b4a8', k: '#1a1a1a' },
    map: [
      'KKKKKKKKKKKKKKKK',
      'KRRRRRRRRRRRRRRK',
      'KRrRRRRrRRRRrRRK',
      'KRRRRRRRRRRRRRRK',
      'KRRRrRRRRRRrRRRK',
      'KRRRRRRRRRRRRRRK',
      'KWWWWWWWWWWWWWWK',
      'KWkWWkWkWWkWWkWK',
      'KWkWkWkWkWkWWkWK',
      'KWWWWWWWWWWWWWWK',
      'KRRRRRRRRRRRRRRK',
      'KRrRRRRrRRRRrRRK',
      'KRRRRRRRRRRRRRRK',
      'KRRRrRRRRrRRRRRK',
      'KRRRRRRRRRRRRRRK',
      'KKKKKKKKKKKKKKKK'
    ]
  };

  MAPS.creeper = {
    pal: { g: '#4da038', G: '#67c04b', d: '#3a7a29', K: '#161616' },
    map: [
      'gggggggggggggggg',
      'gGggggdggggGgggg',
      'ggggggggggdggggg',
      'ggKKKKggggKKKKgg',
      'ggKKKKggggKKKKgg',
      'gdKKKKggggKKKKdg',
      'ggggggKKKKgggggg',
      'ggggggKKKKgggggg',
      'ggggKKKKKKKKgggg',
      'ggggKKKKKKKKgggg',
      'ggggKKKggKKKgggg',
      'gggGKKKggKKKGggg',
      'gggggggggggggggg',
      'ggdgggGgggggdggg',
      'gggggggggggggggg',
      'dgggggggggggggGd'
    ]
  };

  MAPS.chest = {
    pal: { K: '#33240f', c: '#b0824a', C: '#8f6534', m: '#cfd3d6', M: '#8f9599' },
    map: [
      'KKKKKKKKKKKKKKKK',
      'KccccccccccccccK',
      'KcCcccccccccCccK',
      'KccccccccccccccK',
      'KccccccccccccccK',
      'KKKKKKKKKKKKKKKK',
      'KCCCCCCmmCCCCCCK',
      'KCCCCCCmMCCCCCCK',
      'KCCCCCCCCCCCCCCK',
      'KCcCCCCCCCCCcCCK',
      'KCCCCCCCCCCCCCCK',
      'KCCCCcCCCCcCCCCK',
      'KCCCCCCCCCCCCCCK',
      'KCcCCCCCCCCCcCCK',
      'KCCCCCCCCCCCCCCK',
      'KKKKKKKKKKKKKKKK'
    ]
  };

  MAPS.crafting = {
    pal: { K: '#33240f', t: '#a5784a', p: '#9c7040', P: '#7d5a30' },
    map: [
      'KKKKKKKKKKKKKKKK',
      'KttKtttKtttKtttK',
      'KttKtttKtttKtttK',
      'KttKtttKtttKtttK',
      'KKKKKKKKKKKKKKKK',
      'KttttKtttttKtttK',
      'KttttKtttttKtttK',
      'KKKKKKKKKKKKKKKK',
      'KppppppppppppppK',
      'KpPpppppppPppppK',
      'KppppppppppppppK',
      'KpppppPPpppppppK',
      'KppppppppppppppK',
      'KpPpppppppppPppK',
      'KppppppppppppppK',
      'KKKKKKKKKKKKKKKK'
    ]
  };

  MAPS.ender_pearl = {
    pal: { K: '#0b2e2a', T: '#2fae8f', t: '#1e7a64', W: '#bff3e2' },
    map: [
      '.....KKKKKK.....',
      '...KKTTTTTTKK...',
      '..KTTTTTTTTTTK..',
      '.KTTWWTTTTTTTTK.',
      '.KTWWWTTTTTTTTK.',
      'KTTWWTTTTTTTTTTK',
      'KTWWTTTTTTTTTTTK',
      'KTTTTTTTTTTTTTTK',
      'KTTTTTTTTTTTTtTK',
      'KTTTTTTTTTTTTTTK',
      'KTTTTTTTTTTTTTTK',
      '.KTTTTTTTTTTTTK.',
      '.KTTTTtTTTTTTTK.',
      '..KTTTTTTTTTTK..',
      '...KKTTTTTTKK...',
      '.....KKKKKK.....'
    ]
  };

  MAPS.heart = {
    pal: { R: '#e0332f', r: '#a11d1a', W: '#ffb3ae' },
    map: [
      '................',
      '..RRRR...RRRR...',
      '.RWRRRRRRRRRRRR.',
      'RRRRRRRRRRRRRRRR',
      'RRRRRRRRRRRRRRRr',
      'RRRRRRRRRRRRRRrr',
      '.RRRRRRRRRRRRRr.',
      '..RRRRRRRRRRRr..',
      '...RRRRRRRRRr...',
      '....RRRRRRRr....',
      '.....RRRRRr.....',
      '......RRRr......',
      '.......Rr.......',
      '................',
      '................',
      '................'
    ]
  };

  MAPS.pickaxe = {
    pal: { i: '#c8cdd1', I: '#969da3', b: '#7a5528', B: '#5e3f1c' },
    map: [
      '....iiiiiiii....',
      '..iiiiiiiiiiii..',
      '.iiiI........ii.',
      '.iiI...bb.....i.',
      '.iI...bbb....I..',
      '..i...bbb...i...',
      '...i..bbb..i....',
      '....i.bbb.i.....',
      '.....bbb........',
      '....bbb.........',
      '....bbb.........',
      '...bbb..........',
      '...bbb..........',
      '..bbb...........',
      '..bb............',
      '................'
    ]
  };

  /* --------------------------------- UI GLYPHS --------------------------------- */
  // 'X' = currentColor, 'x' = dark shade, 'o' = light shade

  function uiPal() {
    return { X: 'currentColor', x: 'rgba(0,0,0,0.38)', o: 'rgba(255,255,255,0.35)' };
  }

  var UI = {
    play: [
      'XX..............',
      'XXXX............',
      'XXXXXX..........',
      'XXXXXXXX........',
      'XXXXXXXXXX......',
      'XXXXXXXXXXXX....',
      'XXXXXXXXXXXXXX..',
      'XXXXXXXXXXXXXXXX',
      'XXXXXXXXXXXXXXXX',
      'XXXXXXXXXXXXXX..',
      'XXXXXXXXXXXX....',
      'XXXXXXXXXX......',
      'XXXXXXXX........',
      'XXXXXX..........',
      'XXXX............',
      'XX..............'
    ],
    stop: [
      '................',
      '..oooooooooo....',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '.oXXXXXXXXXXx...',
      '...xxxxxxxxxx...',
      '................',
      '................',
      '................'
    ],
    restart: [
      '.....XXXXXX.....',
      '...XX......XX...',
      '..X.........XXX.',
      '.X..........XXX.',
      '.X..........XX..',
      '.X..............',
      '.X..............',
      '.X..............',
      '..X.............',
      '..X.........X...',
      '...XX......XX...',
      '.....XXXXXX.....',
      '................',
      '................',
      '................',
      '................'
    ],
    dashboard: [
      '................',
      '..oooo...oooo...',
      '..oXXx...oXXx...',
      '..oXXx...oXXx...',
      '..xXXx...xXXx...',
      '................',
      '..oooo...oooo...',
      '..oXXx...oXXx...',
      '..oXXx...oXXx...',
      '..xXXx...xXXx...',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    servers: [
      '................',
      '..ooooooooooo...',
      '..oXXXXXXXXXx...',
      '..xXXXXXXXXXx...',
      '................',
      '.....ooooooo....',
      '....oXXXXXXXx...',
      '....xXXXXXXXx...',
      '................',
      '..ooooooooooo...',
      '..oXXXXXXXXXx...',
      '..xXXXXXXXXXx...',
      '................',
      '................',
      '................',
      '................'
    ],
    box: [
      '................',
      '..XXXXXXXXXXXX..',
      '..XooooooooooX..',
      '..XoXXXXXXXXxX..',
      '..XoXXXxxXXXxX..',
      '..XoXXXxxXXXxX..',
      '..XoXXXXXXXXxX..',
      '..XoXXXxxXXXxX..',
      '..XoXXXxxXXXxX..',
      '..XoXXXXXXXXxX..',
      '..XoXXXXXXXXxX..',
      '..XxXXXXXXXXxX..',
      '..XXXXXXXXXXXX..',
      '................',
      '................',
      '................'
    ],
    search: [
      '...XXXXX........',
      '..X.....X.......',
      '.X.......X......',
      '.X.......X......',
      '.X.......X......',
      '..X.....X.......',
      '...XXXXX.X......',
      '.........XX.....',
      '..........XX....',
      '...........XX...',
      '............XX..',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    close: [
      '................',
      '..XX......XX....',
      '..XXX....XXX....',
      '...XXX..XXX.....',
      '....XXXXXX......',
      '.....XXXX.......',
      '.....XXXX.......',
      '....XXXXXX......',
      '...XXX..XXX.....',
      '..XXX....XXX....',
      '..XX......XX....',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    back: [
      '................',
      '......XX........',
      '.....XXX........',
      '....XXXX........',
      '...XXXXXXXXXXX..',
      '..XXXXXXXXXXXX..',
      '..XXXXXXXXXXXX..',
      '...XXXXXXXXXXX..',
      '....XXXX........',
      '.....XXX........',
      '......XX........',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    trash: [
      '................',
      '.....XXXXXX.....',
      '..XXXXXXXXXXXX..',
      '..X..X....X..X..',
      '...X.X....X.X...',
      '...X.X....X.X...',
      '...X.X....X.X...',
      '...X.X....X.X...',
      '...X.X....X.X...',
      '...X.X....X.X...',
      '...X.X....X.X...',
      '...XXXXXXXXXX...',
      '....XXXXXXXX....',
      '................',
      '................',
      '................'
    ],
    download: [
      '......XXXX......',
      '......XXXX......',
      '......XXXX......',
      '......XXXX......',
      '..XXXXXXXXXXXX..',
      '...XXXXXXXXXX...',
      '....XXXXXXXX....',
      '.....XXXXXX.....',
      '......XXXX......',
      '.......XX.......',
      '..XXXXXXXXXXXX..',
      '..XXXXXXXXXXXX..',
      '................',
      '................',
      '................',
      '................'
    ],
    logout: [
      '................',
      '..XXXXXX........',
      '..X....X........',
      '..X.XXXXXX......',
      '..X.X.....XX....',
      '..X.XXXXX..X....',
      '..X.X.....XX....',
      '..X.XXXXXX......',
      '..X....X........',
      '..XXXXXX........',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    cpu: [
      '..X..X..X..X....',
      '..X..X..X..X....',
      '..XXXXXXXXXX....',
      '..XooooooooX....',
      '..XoXXXXXXxX..X.',
      '..XoX....XxX..X.',
      '..XoX.XX.XxX..X.',
      '..XoX.XX.XxX..X.',
      '..XoX....XxX..X.',
      '..XoXXXXXXxX..X.',
      '..XxxxxxxxxX....',
      '..XXXXXXXXXX....',
      '..X..X..X..X....',
      '..X..X..X..X....',
      '................',
      '................'
    ],
    ram: [
      '................',
      '................',
      '..XXXXXXXXXXXXX.',
      '..XoXoXoXoXoXoX.',
      '..XXXXXXXXXXXXX.',
      '..X..X..X..X..X.',
      '..X..X..X..X..X.',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    players: [
      '................',
      '.....XXXX.......',
      '....XooooX......',
      '....XoXXoX......',
      '....XooooX......',
      '.....XXXX.......',
      '....XXXXXX......',
      '...XoXXXXoX.....',
      '...XoXXXXoX.....',
      '....X....X......',
      '....X....X......',
      '....X....X......',
      '....X....X......',
      '................',
      '................',
      '................'
    ],
    bolt: [
      '........XXX.....',
      '.......XXX......',
      '......XXX.......',
      '.....XXXXXXX....',
      '....XXXXXXX.....',
      '.......XXX......',
      '......XXX.......',
      '.....XXX........',
      '....XXX.........',
      '...XXX..........',
      '...XX...........',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    clock: [
      '.....XXXXXX.....',
      '...XX......XX...',
      '..X....X.....X..',
      '.X.....X......X.',
      '.X.....X......X.',
      '.X.....XXXXX..X.',
      '.X............X.',
      '.X............X.',
      '..X..........X..',
      '...XX......XX...',
      '.....XXXXXX.....',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    plus: [
      '................',
      '......XXXX......',
      '......XXXX......',
      '......XXXX......',
      '......XXXX......',
      '..XXXXXXXXXXXX..',
      '..XXXXXXXXXXXX..',
      '..XXXXXXXXXXXX..',
      '..XXXXXXXXXXXX..',
      '......XXXX......',
      '......XXXX......',
      '......XXXX......',
      '......XXXX......',
      '................',
      '................',
      '................'
    ],
    gear: [
      '......XXX.......',
      '......XXX.......',
      '..X..XXXXX..X...',
      '..XX.XXXXX.XX...',
      '..XXXXXXXXXXX...',
      '.XXXXXXXXXXXXX..',
      '.XXXX.....XXXX..',
      'XXXX.......XXXX.',
      'XXXX.......XXXX.',
      '.XXXX.....XXXX..',
      '.XXXXXXXXXXXXX..',
      '..XXXXXXXXXXX...',
      '..XX.XXXXX.XX...',
      '..X..XXXXX..X...',
      '......XXX.......',
      '......XXX.......'
    ],
    terminal: [
      '..XXXXXXXXXXXX..',
      '..XooooooooooX..',
      '..XoX........X..',
      '..XoXX.......X..',
      '..XoXXX......X..',
      '..XoXX.......X..',
      '..XoX..XXXX..X..',
      '..XoX........X..',
      '..XxXXXXXXXXxX..',
      '..XXXXXXXXXXXX..',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................'
    ]
  };

  function validate() {
    var errors = [];
    Object.keys(MAPS).forEach(function (k) {
      MAPS[k].map.forEach(function (row, i) {
        if (row.length !== 16) errors.push(k + ' row ' + i + ' len=' + row.length);
        row.split('').forEach(function (ch) {
          if (ch !== '.' && !(ch in MAPS[k].pal)) errors.push(k + ' row ' + i + ' missing pal "' + ch + '"');
        });
      });
      if (MAPS[k].map.length !== 16) errors.push(k + ' rows=' + MAPS[k].map.length);
    });
    Object.keys(UI).forEach(function (k) {
      UI[k].forEach(function (row, i) {
        if (row.length !== 16) errors.push('ui:' + k + ' row ' + i + ' len=' + row.length);
        row.split('').forEach(function (ch) {
          if (ch !== '.' && ch !== 'X' && ch !== 'x' && ch !== 'o') errors.push('ui:' + k + ' row ' + i + ' bad char "' + ch + '"');
        });
      });
      if (UI[k].length !== 16) errors.push('ui:' + k + ' rows=' + UI[k].length);
    });
    return errors;
  }

  // Map server.icon values (and common aliases) to icon keys.
  var ICON_ALIASES = {
    grass: 'grass', dirt: 'dirt', diamond: 'diamond', gem: 'diamond',
    diamond_ore: 'diamond_ore', diamondore: 'diamond_ore', ore: 'diamond_ore',
    redstone: 'redstone', tnt: 'tnt', creeper: 'creeper', chest: 'chest',
    crafting: 'crafting', crafting_table: 'crafting', ender: 'ender_pearl',
    ender_pearl: 'ender_pearl', pearl: 'ender_pearl', heart: 'heart', pickaxe: 'pickaxe'
  };

  var Icons = {
    // Block/item icon -> svg string (fixed palette)
    get: function (name) {
      var key = ICON_ALIASES[String(name || '').toLowerCase()] || 'grass';
      var def = MAPS[key] || MAPS.grass;
      return px(def.map, def.pal);
    },
    // UI glyph -> svg string using currentColor
    ui: function (name) {
      var map = UI[name] || UI.box;
      return px(map, uiPal());
    },
    // All block-icon keys (for the icon picker)
    blockKeys: Object.keys(MAPS),
    uiKeys: Object.keys(UI),
    // Rasterize an icon onto a canvas (used by the animated background)
    draw: function (name, scale) {
      scale = scale || 4;
      var key = ICON_ALIASES[String(name || '').toLowerCase()] || 'grass';
      var def = MAPS[key] || MAPS.grass;
      var cv = document.createElement('canvas');
      cv.width = 16 * scale; cv.height = 16 * scale;
      var ctx = cv.getContext('2d');
      def.map.forEach(function (row, y) {
        for (var x = 0; x < row.length; x++) {
          var ch = row[x];
          if (ch === '.') continue;
          ctx.fillStyle = def.pal[ch];
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      });
      return cv;
    },
    _validate: validate
  };

  global.Icons = Icons;
  if (typeof module !== 'undefined' && module.exports) module.exports = Icons;
})(typeof window !== 'undefined' ? window : globalThis);
