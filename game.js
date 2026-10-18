// game.js — прототип Tower Defense на Phaser 3.
// Шаг 10: управляемые волны врагов с кнопкой старта.
// Сохранены механики прошлых шагов: сетка, дорога, движение врагов, стрельба, анимации.
// Логика разбита на маленькие методы, чтобы дальше удобно наращивать механики.
//
// ВАЖНО: game.js подключается как ES-модуль (<script type="module">),
// поэтому здесь доступны оператор import и значения из других модулей.

// Firebase подключается ЛЕНИВО — прямо в saveRecord (см. ниже).
// Так большие скрипты gstatic не тормозят открытие игры:
// они скачиваются только в момент сохранения рекорда.

// ----------------------------- Константы -----------------------------
// Адрес серверного API (Vercel).
// На тестовой версии (домен vercel.app) API на том же домене — без CORS.
const API_BASE = location.hostname.endsWith('vercel.app')
  ? ''
  : 'https://telegram-tower-defense.vercel.app';

const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const GRID_SIZE = 10;             // размер сетки: 10 на 10 клеток
const BG_COLOR = 0x0a0c12;        // цвет фона сцены (тёмный графит лаборатории)
const CELL_COLOR = 0x1a1a1a;      // заливка обычной (свободной) клетки
const ROAD_COLOR = 0x666666;      // заливка дороги (серый)
const GRID_LINE_COLOR = 0x333333; // цвет линий сетки

const TOWER_COLOR = 0xe63946;     // акцентный цвет интерфейса башен
const TOWER_MAX_LEVEL = 5;        // максимальный уровень башни
const TOWER_SELL_RATIO = 0.7;     // возврат золота при продаже (70% вложенного)
// Размер спрайта (size) и радиус для коллизий/кликов (radius) задаются
// индивидуально у каждого типа в TOWER_TYPES.

// Типы башен. cost — цена постройки, range — радиус в клетках,
// fireRate — выстрелов в секунду, damage — урон, texture — картинка.
const TOWER_TYPES = {
  gunner: {
    name: 'Стрелок',
    cost: 25,
    range: 2.5,
    fireRate: 1,
    damage: 1,
    accuracy: 1, // всегда попадает
    footprint: 0.7, // размер корпуса в клетках
    weaponScale: 0.5, // во сколько раз пушка меньше корпуса
    baseTexture: 'tower', // корпус (стоит на месте)
    texture: 'tower', // запасная картинка
    color: 0xe63946,
    baseOrigin: { x: 0.5, y: 0.5 }, // опора корпуса — центр картинки
    gunOrigin: { x: 0.5, y: 0.5 },  // опора пушки — точка крепления в картинке
    gunOrbit: 0.30,                 // радиус облёта пушки вокруг корпуса (в долях клетки)
    gunOrbitX: 1.15,                // растяжение орбиты по горизонтали (по бокам чуть дальше)
    gunOrbitY: 0.5,                 // сжатие орбиты по вертикали (1 = круг; меньше = пушка спереди/сзади ближе к телу)
    gunMount: { x: 0, y: 0.1 },     // доп. сдвиг пушки (в долях клетки) — ниже
  },
  minigun: {
    name: 'Миниган',
    cost: 40,
    range: 3.5,      // бьёт дальше стрелка
    fireRate: 4,
    damage: 1,
    accuracy: 0.7,   // 70% попаданий, 30% — разброс
    footprint: 1.0,  // крупнее стрелка
    weaponScale: 0.75, // пулемёт крупнее пистолета
    baseTexture: 'tower_minigun', // корпус (стоит на месте)
    texture: 'tower_minigun', // запасная картинка
    color: 0x3498db,
    baseOrigin: { x: 0.5, y: 0.5 },
    gunOrigin: { x: 0.5, y: 0.5 },
    gunOrbit: 0.36,
    gunOrbitX: 1.15,
    gunOrbitY: 0.5,
    gunMount: { x: 0, y: 0.1 },
  },
};

const ENEMY_HIT_COLOR = 0xffffff; // вспышка врага при попадании
const ENEMY_HP = 3;               // базовое здоровье врага по умолчанию
const ENEMY_HP_SCALE = 0.12;      // прирост HP врагов за волну (множитель)

// Типы врагов. hp — базовое здоровье, speed — клеток/сек, color — цвет,
// reward — золото за убийство, size — размер от клетки.
// damageMultiplier — множитель получаемого урона (броня).
// shield / shieldColor — отдельный запас щита (щитоносец).
// splitInto / splitCount — на кого распадается при смерти.
// livesDamage — сколько жизней снимает, если дойдёт до конца.
const ENEMY_TYPES = {
  normal: { hp: 3, speed: 2.0, color: 0xe74c3c, reward: 8, size: 0.60 },
  fast: { hp: 2, speed: 4.2, color: 0xf39c12, reward: 6, size: 0.45 },
  armored: {
    hp: 8,
    speed: 1.5,
    color: 0x7f8c8d,
    reward: 14,
    size: 0.62,
    damageMultiplier: 0.6,
  },
  tank: { hp: 26, speed: 0.9, color: 0x8e44ad, reward: 30, size: 0.80 },
  splitter: {
    hp: 12,
    speed: 1.6,
    color: 0x27ae60,
    reward: 15,
    size: 0.70,
    splitInto: 'small',
    splitCount: 2,
  },
  small: { hp: 2, speed: 3.2, color: 0xe63946, reward: 3, size: 0.34 },
  shielded: {
    hp: 15,
    speed: 1.4,
    color: 0x2980b9,
    reward: 25,
    size: 0.70,
    shield: 12,
    shieldColor: 0x66ccff,
  },
  boss: { hp: 160, speed: 0.8, color: 0x2c3e50, reward: 220, size: 1.15, livesDamage: 3 },
};

// ----------------------------- Волны -----------------------------
const SPAWN_INTERVAL = 1000;      // базовая задержка между спавном, мс
const SPAWN_INTERVAL_MIN = 300;   // минимальная задержка (дальше волны — быстрее)
const WAVE_CLEAR_BONUS = 25;      // бонус золота за зачистку волны

// Состав волн 1–20 по документу. Дальше — процедурно (buildEndlessWave).
const WAVE_TABLE = [
  { normal: 10 }, // 1
  { normal: 15 }, // 2
  { normal: 20 }, // 3
  { normal: 15, fast: 5 }, // 4
  { normal: 20, fast: 8 }, // 5
  { normal: 15, fast: 15 }, // 6
  { normal: 20, armored: 5 }, // 7
  { normal: 15, fast: 10, armored: 8 }, // 8
  { normal: 25, armored: 10 }, // 9
  { normal: 20, armored: 5, tank: 3 }, // 10
  { normal: 20, fast: 10, tank: 5 }, // 11
  { normal: 25, armored: 8, tank: 5 }, // 12
  { normal: 20, splitter: 5 }, // 13
  { fast: 15, splitter: 8, armored: 5 }, // 14
  { normal: 25, fast: 10, splitter: 8, tank: 3 }, // 15
  { normal: 20, shielded: 8, armored: 5 }, // 16
  { fast: 15, shielded: 10, tank: 5 }, // 17
  { normal: 20, armored: 10, shielded: 8, splitter: 5 }, // 18
  { fast: 10, armored: 8, tank: 5, shielded: 8, splitter: 5 }, // 19
  { boss: 1, normal: 20, fast: 10, armored: 5 }, // 20
];

const PROJECTILE_COLOR = 0xf1c40f; // цвет снаряда (жёлтый)
const PROJECTILE_SPEED = 10;       // скорость снаряда: клеток в секунду
const PROJECTILE_DAMAGE = 1;       // урон за попадание

const START_GOLD = 100;           // стартовое золото игрока
const START_LIVES = 10;           // стартовые жизни игрока

// Маршрут врагов задаётся угловыми точками (по клеткам сетки).
// ----------------------------- Мир / изометрия -----------------------------
// 1 старая клетка = 1 world unit. Мир 10x10 юнитов.
const WORLD_SIZE = GRID_SIZE;
const ISO_HW = 64; // половина ширины изотайла (128 / 2)
const ISO_HH = 32; // половина высоты изотайла (64 / 2)
const ROAD_WIDTH = 1.0; // ширина дороги в world units

// Версия ассетов в запросе — сбрасывает кеш картинок в браузере/Telegram.
const ASSET_VER = '?v=20261010g';

// Насколько визуально поднять спрайт над его клеткой (в долях клетки).
// Зона тапа при этом остаётся на клетке (не смещается).
const BASE_LIFT = 0.2;

// HiDPI-масштаб: рендерим канвас в физическом разрешении экрана, а UI
// задаём в «CSS-пикселях», умножая абсолютные размеры на DPR. Ограничиваем
// двойкой ради производительности на слабых телефонах.
const DPR = Math.min(window.devicePixelRatio || 1, 2);

// ЕДИНОЕ преобразование world <-> экран (iso-пиксели). Больше нигде нет iso-математики.
function worldToScreen(wx, wy) {
  return { x: (wx - wy) * ISO_HW, y: (wx + wy) * ISO_HH };
}
function screenToWorld(sx, sy) {
  return { x: (sx / ISO_HW + sy / ISO_HH) / 2, y: (sy / ISO_HH - sx / ISO_HW) / 2 };
}

// ----------------------------- Направления (8 сторон) -----------------------------
// Порядок = экранные углы (y вниз): 0° вправо, 45° вправо-вниз, 90° вперёд(вниз),
// 135° влево-вниз, 180° влево, 225° влево-вверх, 270° назад(вверх), 315° вправо-вверх.
// Спрайты рисуются в этих ЭКРАННЫХ направлениях (диагонали — экранные 45°).
const DIRECTIONS = ['r', 'fr', 'f', 'fl', 'l', 'bl', 'b', 'br'];
const DIR_FORWARD = 'f';        // направление по умолчанию (вниз, на камеру)
const DIR_STEP = Math.PI / 4;   // сектор 45°
const DIR_HYSTERESIS = 0.15;    // ~8.6°: зона стабилизации у границы сектора

// Угол (радианы) для направления.
function dirToAngle(dir) {
  const i = DIRECTIONS.indexOf(dir);
  return (i < 0 ? DIRECTIONS.indexOf(DIR_FORWARD) : i) * DIR_STEP;
}

// Кратчайшая разница углов в диапазоне (-π, π].
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Ближайшее из 8 направлений. С гистерезисом держим текущее, пока угол не ушёл
// за границу сектора на DIR_HYSTERESIS — чтобы не дёргалось на стыках.
function angleToDir(angle, current) {
  let idx = Math.round(angle / DIR_STEP);
  idx = ((idx % 8) + 8) % 8;
  if (current) {
    const ci = DIRECTIONS.indexOf(current);
    if (ci !== -1 && Math.abs(angleDiff(angle, ci * DIR_STEP)) <= DIR_STEP / 2 + DIR_HYSTERESIS) {
      return current;
    }
  }
  return DIRECTIONS[idx];
}

// Точка на эллипсе (полуоси rx, ry) с РАВНОМЕРНОЙ скоростью движения: угол цели
// пересчитывается в параметр так, чтобы равное изменение угла = равный путь по дуге.
// Иначе на вытянутом овале пушка сбоку ползёт, а спереди проскакивает.
const _ellipseArcCache = new Map();
function ellipseArcPoint(angle, rx, ry) {
  const key = `${rx}_${ry}`;
  let t = _ellipseArcCache.get(key);
  if (!t) {
    const N = 64;
    const twoPi = Math.PI * 2;
    const step = twoPi / N;
    const arcs = new Float64Array(N + 1);
    let total = 0;
    let px = rx;
    let py = 0;
    for (let i = 1; i <= N; i++) {
      const phi = i * step;
      const cx = rx * Math.cos(phi);
      const cy = ry * Math.sin(phi);
      total += Math.hypot(cx - px, cy - py);
      arcs[i] = total;
      px = cx;
      py = cy;
    }
    t = { N, step, arcs, total, twoPi };
    _ellipseArcCache.set(key, t);
  }
  let a = angle % t.twoPi;
  if (a < 0) a += t.twoPi;
  const target = (a / t.twoPi) * t.total;
  let lo = 1;
  let hi = t.N;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t.arcs[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const a0 = t.arcs[lo - 1];
  const a1 = t.arcs[lo];
  const f = a1 > a0 ? (target - a0) / (a1 - a0) : 0;
  const phi = (lo - 1 + f) * t.step;
  return { x: rx * Math.cos(phi), y: ry * Math.sin(phi) };
}

// ----------------------------- Спрайт-лист (одна картинка на все позы) -----------------------------
// Раскладка 4x2, порядок клеток (слева-вправо, сверху-вниз):
//   ряд 1: вперёд, вперёд-право, вправо, назад-право
//   ряд 2: назад, назад-лево, влево, вперёд-лево
// Игра сама режет лист на 8 отдельных текстур вида "<prefix>_<dir>".
const SHEET_ORDER = ['f', 'fr', 'r', 'br', 'b', 'bl', 'l', 'fl'];
const SHEET_COLS = 4;
const SHEET_ROWS = 2;

function sliceSheet(scene, sheetKey, prefix) {
  if (!scene.textures.exists(sheetKey)) return;
  const source = scene.textures.get(sheetKey).getSourceImage();
  const cellW = Math.floor(source.width / SHEET_COLS);
  const cellH = Math.floor(source.height / SHEET_ROWS);
  if (cellW < 1 || cellH < 1) return;
  SHEET_ORDER.forEach((dir, index) => {
    const key = `${prefix}_${dir}`;
    if (scene.textures.exists(key)) return; // отдельный файл имеет приоритет
    const canvas = document.createElement('canvas');
    canvas.width = cellW;
    canvas.height = cellH;
    canvas.getContext('2d').drawImage(
      source,
      (index % SHEET_COLS) * cellW,
      Math.floor(index / SHEET_COLS) * cellH,
      cellW,
      cellH,
      0,
      0,
      cellW,
      cellH
    );
    scene.textures.addCanvas(key, canvas);
  });
}

// ------------- Скруглённые фоны кнопок и окон -------------
// Phaser не умеет скруглять фон у Text/Rectangle, поэтому рисуем скруглённый
// прямоугольник графикой. Для объектов внутри контейнеров фон добавляем в тот же
// контейнер (под объект) — тогда масштаб/позиция совпадают; для сценных — с учётом scrollFactor.
function isVisibleDeep(obj) {
  let o = obj;
  while (o) {
    if (o.visible === false) return false;
    o = o.parentContainer;
  }
  return true;
}

function roundTarget(scene, obj, opts) {
  const kind = opts.kind || 'text';
  const g = scene.add.graphics();
  const inContainer = !!obj.parentContainer;
  if (inContainer) {
    const idx = obj.parentContainer.getIndex(obj);
    obj.parentContainer.addAt(g, Math.max(0, idx));
  } else {
    g.setDepth((obj.depth || 0) - 0.5);
    g.setScrollFactor(obj.scrollFactorX, obj.scrollFactorY);
  }

  if (kind === 'text') {
    try {
      // Прячем встроенный прямоугольный фон (делаем его прозрачным).
      if (obj.setStyle) obj.setStyle({ backgroundColor: 'rgba(0,0,0,0)' });
      if (obj.style) obj.style.backgroundColor = 'rgba(0,0,0,0)';
      if (obj.updateText) obj.updateText();
    } catch (error) {
      /* не критично */
    }
  } else {
    // Полностью отключаем родную заливку и обводку прямоугольника.
    obj.isFilled = false;
    obj.isStroked = false;
  }

  scene._roundBgs = scene._roundBgs || [];
  const item = {
    g: g,
    obj: obj,
    kind: kind,
    color: opts.color,
    alpha: opts.alpha === undefined ? 1 : opts.alpha,
    radius: opts.radius,
    strokeColor: opts.strokeColor,
    strokeAlpha: opts.strokeAlpha === undefined ? 1 : opts.strokeAlpha,
    strokeWidth: opts.strokeWidth || 0,
  };
  scene._roundBgs.push(item);
  obj._roundItem = item;
  return g;
}

// Пересобрать все фоны (размер/позиция/видимость берутся у текущего объекта).
function updateRoundBgs(scene) {
  const list = scene._roundBgs;
  if (!list) return;
  for (const it of list) {
    const o = it.obj;
    let w;
    let h;
    let x;
    let y;
    if (it.kind === 'text') {
      w = o.displayWidth;
      h = o.displayHeight;
      x = o.x + w * (0.5 - o.originX);
      y = o.y + h * (0.5 - o.originY);
    } else {
      w = o.width * o.scaleX;
      h = o.height * o.scaleY;
      x = o.x + w * (0.5 - o.originX);
      y = o.y + h * (0.5 - o.originY);
    }

    it.g.clear();
    if (!isVisibleDeep(o) || w <= 0 || h <= 0) {
      it.g.setVisible(false);
      continue;
    }
    const r = Math.min(it.radius, w / 2, h / 2);
    it.g.setVisible(true);
    it.g.fillStyle(it.color, it.alpha);
    it.g.fillRoundedRect(x - w / 2, y - h / 2, w, h, r);
    if (it.strokeWidth) {
      it.g.lineStyle(it.strokeWidth, it.strokeColor, it.strokeAlpha);
      it.g.strokeRoundedRect(x - w / 2, y - h / 2, w, h, r);
    }
  }
}

// Непрерывный маршрут в world-координатах (центры клеток старого пути).
const ROUTE_WAYPOINTS = [
  { x: 0.5, y: 0.5 },
  { x: 6.5, y: 0.5 },
  { x: 6.5, y: 3.5 },
  { x: 1.5, y: 3.5 },
  { x: 1.5, y: 6.5 },
  { x: 8.5, y: 6.5 },
  { x: 8.5, y: 9.5 },
  { x: 9.5, y: 9.5 },
];

// Route = { waypoints, segments, length }
function buildRoute(waypoints) {
  const segments = [];
  let length = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    segments.push({ a, b, dir: { x: dx / len, y: dy / len }, length: len, sStart: length });
    length += len;
  }
  return { waypoints, segments, length };
}
const ROUTE = buildRoute(ROUTE_WAYPOINTS);

// Расстояние от точки до полилинии маршрута (world units) — источник истины.
function distanceToRoute(px, py, route) {
  let best = Infinity;
  for (const seg of route.segments) {
    const abx = seg.b.x - seg.a.x;
    const aby = seg.b.y - seg.a.y;
    const len2 = abx * abx + aby * aby || 1;
    let t = ((px - seg.a.x) * abx + (py - seg.a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = seg.a.x + abx * t;
    const cy = seg.a.y + aby * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

// ------------------------------ Враг ------------------------------
// Враг — красный квадрат, который плавно едет по клеткам маршрута.
class Enemy extends Phaser.GameObjects.Rectangle {
  constructor(scene, route, typeKey = 'normal', hp = ENEMY_HP, shield = 0) {
    const type = ENEMY_TYPES[typeKey] || ENEMY_TYPES.normal;
    const fillColor = shield > 0 ? type.shieldColor || 0x66ccff : type.color;
    super(scene, 0, 0, 1, 1, fillColor);

    this.typeKey = typeKey;      // ключ типа
    this.config = type;          // настройки типа
    this.baseColor = type.color; // обычный цвет
    this.baseFill = fillColor;   // текущая заливка (со щитом — другая)
    this.speed = type.speed;     // скорость: world units/sec
    this.reward = type.reward;   // золото за убийство
    this.sizeFactor = type.size; // размер относительно клетки
    this.damageMultiplier = type.damageMultiplier || 1; // броня (множитель урона)
    this.shield = shield;        // запас щита (снимается первым)
    this.maxShield = shield;     // изначальный щит (для отображения)

    // Маршрут и непрерывная мировая позиция.
    this.route = route;
    this.segment = 0;
    this.progress = 0;
    this.wx = ROUTE_WAYPOINTS[0].x;
    this.wy = ROUTE_WAYPOINTS[0].y;
    this.dirX = 0;
    this.dirY = 0;

    this.hp = hp;               // здоровье (по умолчанию базовое)
    this.maxHp = hp;            // максимум здоровья (для отображения)
    this.isDead = false;        // мёртв/исчезает — не двигается и не цель для башен

    // Размер — в iso-пикселях (ISO_HW), не зависит от экрана.
    const size = this.sizeFactor * ISO_HW;
    this.setSize(size, size);

    const p = worldToScreen(this.wx, this.wy);
    this.setPosition(p.x, p.y);

    scene.add.existing(this);   // добавляем объект в сцену
    this.refreshDepth();
  }

  // Глубина отрисовки в изометрии — по (wx + wy).
  refreshDepth() {
    this.setDepth(10 + (this.wx + this.wy) * 0.01);
  }

  // world -> экран (только для отрисовки; логика — в world).
  syncScreen() {
    const p = worldToScreen(this.wx, this.wy);
    this.x = p.x;
    this.y = p.y;
    this.refreshDepth();
  }

  // Движение по сегментам Route в world-координатах.
  // delta — мс; экранные координаты в логике движения не участвуют.
  moveAlongPath(delta) {
    const segments = this.route.segments;
    if (this.segment >= segments.length) {
      this.arriveAtEnd();
      return;
    }

    let seg = segments[this.segment];
    this.progress += (this.speed * (delta / 1000)) / seg.length;

    // Перескок через несколько сегментов за один кадр — без телепортов.
    while (this.progress >= 1 && this.segment < segments.length - 1) {
      this.progress -= 1;
      this.segment += 1;
    }

    // Дошли до конца маршрута.
    if (this.segment >= segments.length - 1 && this.progress >= 1) {
      seg = segments[this.segment];
      this.wx = seg.b.x;
      this.wy = seg.b.y;
      this.dirX = seg.dir.x;
      this.dirY = seg.dir.y;
      this.syncScreen();
      this.arriveAtEnd();
      return;
    }

    seg = segments[this.segment];
    this.wx = Phaser.Math.Linear(seg.a.x, seg.b.x, this.progress);
    this.wy = Phaser.Math.Linear(seg.a.y, seg.b.y, this.progress);
    this.dirX = seg.dir.x;
    this.dirY = seg.dir.y;
    this.syncScreen();
  }

  // Короткая белая вспышка при попадании.
  flash() {
    this.setFillStyle(ENEMY_HIT_COLOR);
    this.scene.time.delayedCall(80, () => {
      if (this.active && !this.isDead) this.setFillStyle(this.baseFill);
    });
  }

  // Получаем урон. Сначала снимается щит, потом здоровье.
  // Броня (damageMultiplier) уменьшает входящий урон.
  takeDamage(amount) {
    if (this.isDead) return;

    const damage = amount * this.damageMultiplier;

    if (this.shield > 0) {
      this.shield -= damage;

      if (this.shield <= 0) {
        // Щит сломан: остаток урона уходит в здоровье.
        this.hp += this.shield;
        this.shield = 0;
        this.baseFill = this.baseColor;
        this.setFillStyle(this.baseFill);
      } else {
        this.flash();
        return;
      }
    } else {
      this.hp -= damage;
    }

    if (this.hp > 0) {
      this.flash();
      return;
    }

    this.die();
  }

  // Смерть: плавно увеличиваем и растворяем квадрат, затем удаляем.
  die() {
    this.isDead = true;
    this.scene.onEnemyKilled(this); // сообщаем сцене (награда золотом)

    // Разделяющийся враг оставляет после себя мелких.
    if (this.config.splitInto) this.scene.onEnemySplit(this);

    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      scale: 1.6,
      duration: 250,
      ease: 'Quad.easeOut',
      onComplete: () => this.destroy(),
    });
  }

  // Враг дошёл до выхода живым — отнимаем жизнь у игрока.
  arriveAtEnd() {
    this.isDead = true;
    this.scene.onEnemyReachedEnd(this);
    this.destroy();
  }
}

// ------------------------------ Снаряд ------------------------------
// Маленький жёлтый кружок, который летит от башни точно в цель (самонаведение).
class Projectile extends Phaser.GameObjects.Arc {
  constructor(scene, x, y, target, damage = PROJECTILE_DAMAGE, willHit = true) {
    super(scene, x, y, Math.max(3, ISO_HW * 0.12), 0, 360, false, PROJECTILE_COLOR);

    this.target = target;   // враг, в которого стреляли
    this.damage = damage;   // урон башни (растёт с уровнем)
    this.willHit = willHit; // попадёт ли этот выстрел

    if (!willHit) {
      // Промах: случайная точка рядом с целью (разброс).
      const spread = ISO_HW * 1.2;
      this.missX = target.x + Phaser.Math.Between(-spread, spread);
      this.missY = target.y + Phaser.Math.Between(-spread, spread);
      this.setAlpha(0.7);
    }

    scene.add.existing(this);
    this.setDepth(50); // снаряды поверх мира (ниже UI 90+)
  }

  // Летим к цели (экранное самонаведение); при попадании наносим урон.
  flyToTarget(delta) {
    const step = PROJECTILE_SPEED * ISO_HW * (delta / 1000);

    // Точный выстрел: самонаведение на врага.
    if (this.willHit) {
      // Цель уже мертва/удалена — снаряд просто исчезает.
      if (!this.target.active || this.target.isDead) {
        this.destroy();
        return;
      }

      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const distance = Math.hypot(dx, dy);

      // Долетели: наносим урон и удаляем снаряд.
      if (distance <= step) {
        this.target.takeDamage(this.damage);
        this.destroy();
        return;
      }

      this.x += (dx / distance) * step;
      this.y += (dy / distance) * step;
      return;
    }

    // Промах: летим в точку разброса, урона не наносим.
    const dx = this.missX - this.x;
    const dy = this.missY - this.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= step) {
      this.destroy();
      return;
    }

    this.x += (dx / distance) * step;
    this.y += (dy / distance) * step;
  }
}

// ------------------------------ Башня ------------------------------
// Башня хранит своё место на сетке, радиус атаки и перезарядку.
class Tower {
  constructor(scene, gx, gy, typeKey = 'gunner') {
    const type = TOWER_TYPES[typeKey] || TOWER_TYPES.gunner;

    this.scene = scene;
    this.gx = gx; // центр башни в клетках (может быть дробным)
    this.gy = gy;
    this.typeKey = typeKey;          // ключ типа ("gunner", "minigun", ...)
    this.config = type;              // настройки типа
    this.level = 1;                  // уровень башни
    this.range = type.range;         // радиус атаки, клеток
    this.fireRate = type.fireRate;   // выстрелов в секунду
    this.damage = type.damage;       // урон за выстрел
    this.accuracy = type.accuracy !== undefined ? type.accuracy : 1; // шанс попадания
    this.cooldown = 0;               // время до следующего выстрела, сек
    this.totalSpent = type.cost;     // сколько золота вложено (для продажи)
    this.aimAngle = dirToAngle(DIR_FORWARD); // куда направлена пушка (радианы)
    this.aimDir = DIR_FORWARD;       // направление пушки (одно из 8)
    this.baseAngle = dirToAngle(DIR_FORWARD); // направление корпуса (радианы)
    this.baseDir = DIR_FORWARD;      // направление корпуса (одно из 8)
    this.sprite = null;              // картинка пушки (вращается)
    this.baseSprite = null;          // картинка корпуса (стоит на месте)
  }

  // Цена следующего улучшения (зависит от типа и уровня).
  getUpgradeCost() {
    return Math.round(this.config.cost * 0.8) * this.level;
  }

  // Сколько золота вернётся при продаже.
  getSellValue() {
    return Math.floor(this.totalSpent * TOWER_SELL_RATIO);
  }

  // Можно ли ещё улучшать башню.
  canUpgrade() {
    return this.level < TOWER_MAX_LEVEL;
  }

  // Улучшение башни: +радиус, +скорость, +урон.
  // cost передаёт сцена — там же списывается золото.
  upgrade(cost) {
    this.level += 1;
    this.range += 0.4;
    this.fireRate += 0.3;
    this.damage += 1;
    this.totalSpent += cost;
  }

  // Позиция на экране (iso) из world-координат.
  getPosition() {
    return worldToScreen(this.gx, this.gy);
  }

  // Обновление башни: перезарядка, поиск цели, выстрел.
  update(delta, enemies) {
    this.cooldown -= delta / 1000;

    const pos = this.getPosition();
    const target = this.findTarget(enemies);

    // Наводим пушку на цель (визуально — по экранным позициям) и поворачиваем корпус.
    // Нет цели — держим последнее направление (не сбрасываем).
    if (target) {
      this.aimAngle = Math.atan2(target.y - pos.y, target.x - pos.x);
      this.aimDir = angleToDir(this.aimAngle, this.aimDir);
      this.baseAngle = this.aimAngle;
      this.baseDir = angleToDir(this.baseAngle, this.baseDir);
    }

    // Стреляем, только если башня умеет стрелять, есть цель и она перезарядилась.
    if (this.fireRate <= 0 || !target || this.cooldown > 0) return;

    // Выстрел из дула: чуть впереди центра по направлению пушки.
    const weaponScale = this.config.weaponScale || 1;
    const muzzleDistance = this.config.footprint * weaponScale * 0.5 * ISO_HW;
    const muzzle = {
      x: pos.x + Math.cos(this.aimAngle) * muzzleDistance,
      y: pos.y + Math.sin(this.aimAngle) * muzzleDistance,
    };

    this.shoot(muzzle, target);
    this.cooldown = 1 / this.fireRate; // перезарядка
  }

  // Целимся в ПЕРВОГО врага — самого продвинутого по дороге (ведущего),
  // из тех, кто в радиусе. segment + progress монотонно растёт по маршруту.
  findTarget(enemies) {
    let best = null;
    let bestLead = -Infinity;

    for (const enemy of enemies) {
      if (!enemy.active || enemy.isDead) continue;

      const distance = Math.hypot(this.gx - enemy.wx, this.gy - enemy.wy);
      if (distance > this.range) continue;

      const lead = enemy.segment + enemy.progress;
      if (lead > bestLead) {
        bestLead = lead;
        best = enemy;
      }
    }

    return best;
  }

  // Создаём снаряд, летящий в цель.
  // С шансом (1 - accuracy) выстрел уходит в «разброс» и не наносит урон.
  shoot(pos, target) {
    const willHit = Math.random() < this.accuracy;
    this.scene.playSfx('sfx_shot', 0.25);
    const projectile = new Projectile(this.scene, pos.x, pos.y, target, this.damage, willHit);
    this.scene.projectiles.push(projectile);
  }
}

// ------------------------------ Сцена ------------------------------
// ------------------------------ Меню ------------------------------
// Отдельный экран: карты тут нет. Вкладки: Инвентарь · Лобби · Топ · Магазин.
class MenuScene extends Phaser.Scene {
  constructor() {
    super('MenuScene');
  }

  preload() {
    // Картинки башен (нужны и инвентарю, и игре).
    this.load.image('tower', 'assets/tower.png' + ASSET_VER);
    this.load.image('tower_minigun', 'assets/tower_minigun.png' + ASSET_VER);
    for (const key in TOWER_TYPES) {
        this.load.image(`${key}_base`, `assets/${key}_base.png${ASSET_VER}`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
          this.load.image(`${key}_${level}`, `assets/${key}_${level}.png${ASSET_VER}`);
      }
    }
    // Спрайт-листы (одна картинка на все позы) — для иконок инвентаря.
    for (const key in TOWER_TYPES) {
      this.load.image(`${key}_base_sheet`, `assets/${key}_base_sheet.png${ASSET_VER}`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        this.load.image(`${key}_gun_${level}_sheet`, `assets/${key}_gun_${level}_sheet.png${ASSET_VER}`);
      }
    }
    // Направленные спрайты (чтобы инвентарь показывал актуальные модели).
    for (const key in TOWER_TYPES) {
      for (const dir of DIRECTIONS) {
        this.load.image(`${key}_base_${dir}`, `assets/${key}_base_${dir}.png${ASSET_VER}`);
        for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
          this.load.image(`${key}_gun_${level}_${dir}`, `assets/${key}_gun_${level}_${dir}.png${ASSET_VER}`);
        }
      }
    }
    this.load.image('template_base_sheet', `assets/template_base_sheet.png${ASSET_VER}`);
    this.load.on('loaderror', () => {});
  }

  create() {
    this.playerInfo = this.getPlayerInfo();
    this.playerRole = 'player';
    this.playerBest = { wave: 0, gold: 0 };
    this.playerRank = 0;
    this.playersTotal = 0;
    this.topList = [];

    this.initTelegram();

    // Нарезаем спрайт-листы (если есть) на отдельные направления (для иконок).
    for (const key in TOWER_TYPES) {
      sliceSheet(this, `${key}_base_sheet`, `${key}_base`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        sliceSheet(this, `${key}_gun_${level}_sheet`, `${key}_gun_${level}`);
      }
    }
    sliceSheet(this, 'template_base_sheet', 'template_base');

    this.background = this.add.rectangle(0, 0, 1, 1, 0x0a0c12, 1).setOrigin(0, 0).setDepth(-1000);

    this.title = this.add
      .text(0, 0, 'SPORE TOWER DEFENSE', {
        fontFamily: UI_FONT,
        fontSize: '36px',
        color: '#ffffff',
        stroke: '#e63946',
        strokeThickness: 2 * DPR,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.createLobby();
    this.createInventory();
    this.createTop();
    this.createShop();
    this.createTabs();

    this.selectTab('lobby');
    this.layout();
    this.scale.off('resize', this.layout, this);
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));

    this.loadPlayerData();
  }

  createLobby() {
    this.lobbyPage = this.add.container(0, 0).setDepth(10);

    // Карточка профиля и рекордов
    this.cardBg = this.add.graphics();

    // Никнейм по центру карточки
    this.playerNick = this.add
      .text(0, 0, 'Гость', {
        fontFamily: UI_FONT,
        fontSize: '18px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    // Разделитель
    this.cardDivider = this.add.graphics();

    // 3 блока показателей: РЕКОРД, ЗОЛОТО, ТОП
    this.statWaveLabel = this.add
      .text(0, 0, 'РЕКОРД', { fontFamily: UI_FONT, fontSize: '11px', color: '#707e94', fontStyle: 'bold' })
      .setOrigin(0.5);
    this.statWaveVal = this.add
      .text(0, 0, '0', { fontFamily: UI_FONT, fontSize: '22px', color: '#ff4d5e', fontStyle: 'bold' })
      .setOrigin(0.5);

    this.statGoldLabel = this.add
      .text(0, 0, 'ЗОЛОТО', { fontFamily: UI_FONT, fontSize: '11px', color: '#707e94', fontStyle: 'bold' })
      .setOrigin(0.5);
    this.statGoldVal = this.add
      .text(0, 0, '0', { fontFamily: UI_FONT, fontSize: '22px', color: '#f1c40f', fontStyle: 'bold' })
      .setOrigin(0.5);

    this.statRankLabel = this.add
      .text(0, 0, 'ТОП', { fontFamily: UI_FONT, fontSize: '11px', color: '#707e94', fontStyle: 'bold' })
      .setOrigin(0.5);
    this.statRankVal = this.add
      .text(0, 0, '—', { fontFamily: UI_FONT, fontSize: '22px', color: '#4ea8de', fontStyle: 'bold' })
      .setOrigin(0.5);

    // Служебные скрытые текстовые объекты для обратной совместимости
    this.profileText = this.add.text(0, 0, '', { fontFamily: UI_FONT, fontSize: '1px' }).setVisible(false);
    this.bestText = this.add.text(0, 0, '', { fontFamily: UI_FONT, fontSize: '1px' }).setVisible(false);

    // Главная кнопка запуска игры
    this.playButton = this.add
      .text(0, 0, 'В БОЙ', {
        fontFamily: UI_FONT,
        fontSize: '22px',
        color: '#ffffff',
        backgroundColor: '#e63946',
        padding: { x: 38 * DPR, y: 13 * DPR },
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });

    this.playButton.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.playButton.setScale(0.96);
    });
    this.playButton.on('pointerup', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.playButton.setScale(1.0);
      this.scene.start('GameScene');
    });
    this.playButton.on('pointerout', () => {
      this.playButton.setScale(1.0);
    });

    roundTarget(this, this.playButton, {
      color: 0xe63946,
      alpha: 1,
      radius: 12 * DPR,
      strokeColor: 0xff6b7a,
      strokeAlpha: 0.9,
      strokeWidth: 1.5 * DPR,
    });

    this.lobbyPage.add([
      this.cardBg,
      this.cardDivider,
      this.playerNick,
      this.statWaveLabel,
      this.statWaveVal,
      this.statGoldLabel,
      this.statGoldVal,
      this.statRankLabel,
      this.statRankVal,
      this.profileText,
      this.bestText,
      this.playButton,
    ]);
  }

  createInventory() {
    this.inventoryPage = this.add.container(0, 0).setVisible(false).setDepth(10);

    this.inventoryTitle = this.add
      .text(0, 0, 'ТУРЕЛИ', {
        fontFamily: UI_FONT,
        fontSize: '22px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.inventoryPage.add(this.inventoryTitle);

    this.inventoryRows = [];
    for (const key in TOWER_TYPES) {
      const type = TOWER_TYPES[key];
      const row = this.add.container(0, 0);

      const bg = this.add
        .rectangle(0, 0, 320, 76, 0x131722, 0.95)
        .setStrokeStyle(1.5 * DPR, 0x272f44, 1);

      const iconTile = this.add.rectangle(-118, 0, 56, 56, 0x1b2030, 0.9);
      roundTarget(this, iconTile, {
        kind: 'rect',
        color: 0x1b2030,
        alpha: 0.9,
        radius: 10 * DPR,
        strokeColor: 0x2e384e,
        strokeWidth: 1 * DPR,
      });

      const icon = this.add.container(-118, 0);
      const baseKey = this.getBaseTextureKey(key) || type.texture;
      if (baseKey) icon.add(this.add.image(0, 0, baseKey).setDisplaySize(48, 48));
      const weaponKey = this.getWeaponTextureKey(key, 1);
      if (weaponKey) icon.add(this.add.image(0, 0, weaponKey).setDisplaySize(48, 48));

      const name = this.add
        .text(-75, -13, type.name, {
          fontFamily: UI_FONT,
          fontSize: '17px',
          color: '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0, 0.5);
      const info = this.add
        .text(-75, 14, `Стоимость: ${type.cost} · Урон: ${type.damage || 1}`, {
          fontFamily: UI_FONT,
          fontSize: '13px',
          color: '#8b98aa',
        })
        .setOrigin(0, 0.5);

      row.add([bg, iconTile, icon, name, info]);
      roundTarget(this, bg, {
        kind: 'rect',
        color: 0x131722,
        alpha: 0.95,
        radius: 14 * DPR,
        strokeColor: 0x252d40,
        strokeAlpha: 1,
        strokeWidth: 1.5 * DPR,
      });
      this.inventoryPage.add(row);
      this.inventoryRows.push(row);
    }
  }

  createTop() {
    this.topPage = this.add.container(0, 0).setVisible(false).setDepth(10);

    this.topTitle = this.add
      .text(0, 0, 'ТОП ИГРОКОВ', {
        fontFamily: UI_FONT,
        fontSize: '22px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.statsText = this.add
      .text(0, 0, '', {
        fontFamily: UI_FONT,
        fontSize: '13px',
        color: '#ff4d5e',
        align: 'center',
        lineSpacing: 4 * DPR,
        backgroundColor: '#141824',
        padding: { x: 14 * DPR, y: 7 * DPR },
      })
      .setOrigin(0.5);
    roundTarget(this, this.statsText, {
      color: 0x141824,
      alpha: 0.95,
      radius: 10 * DPR,
      strokeColor: 0x242c3e,
      strokeWidth: 1 * DPR,
    });

    // Карточка топа
    this.topCardGfx = this.add.graphics();

    // Маска скролла для списка игроков
    this.topMaskGfx = this.make.graphics();
    this.topMask = this.topMaskGfx.createGeometryMask();

    // Контейнер элементов списка
    this.topListContainer = this.add.container(0, 0);
    this.topListContainer.setMask(this.topMask);

    // Скроллбар
    this.topScrollbarGfx = this.add.graphics();

    // Зона скролла (тач и перетаскивание списка)
    this.topScrollZone = this.add.zone(0, 0, 10, 10).setOrigin(0, 0);
    this.topScrollZone.setInteractive({ useHandCursor: true });

    // Сообщение при загрузке или пустом списке
    this.topEmptyText = this.add
      .text(0, 0, 'Загрузка…', {
        fontFamily: UI_FONT,
        fontSize: '15px',
        color: '#707e94',
        align: 'center',
      })
      .setOrigin(0.5);

    this.topPage.add([
      this.topCardGfx,
      this.topListContainer,
      this.topScrollbarGfx,
      this.topScrollZone,
      this.topEmptyText,
      this.topTitle,
      this.statsText,
    ]);

    this.initTopScroll();
  }

  initTopScroll() {
    this.topScrollOffset = 0;
    this.topMinScrollOffset = 0;
    let isDragging = false;
    let startY = 0;
    let startOffset = 0;

    this.topScrollZone.on('pointerdown', (pointer) => {
      if (this.currentTab !== 'top') return;
      isDragging = true;
      startY = pointer.y;
      startOffset = this.topScrollOffset;
    });

    this.input.on('pointermove', (pointer) => {
      if (!isDragging || this.currentTab !== 'top') return;
      const dy = pointer.y - startY;
      this.applyTopScroll(startOffset + dy);
    });

    const stopDrag = () => {
      isDragging = false;
    };
    this.input.on('pointerup', stopDrag);
    this.input.on('pointerupoutside', stopDrag);

    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      if (this.currentTab !== 'top') return;
      this.applyTopScroll(this.topScrollOffset - deltaY * 0.4);
    });
  }

  applyTopScroll(offset) {
    const minOffset = this.topMinScrollOffset || 0;
    const maxOffset = 0;
    this.topScrollOffset = Phaser.Math.Clamp(offset, minOffset, maxOffset);
    if (this.topListContainer) {
      this.topListContainer.y = (this.topListBaseY || 0) + this.topScrollOffset;
    }
    this.drawTopScrollbar();
  }

  drawTopScrollbar() {
    if (!this.topScrollbarGfx) return;
    this.topScrollbarGfx.clear();
    const totalH = this.topContentH || 0;
    const viewH = this.topVisibleH || 0;
    if (totalH <= viewH || viewH <= 0) return;

    const scrollbarX = this.topCardX + this.topCardW - 7 * DPR;
    const trackY = this.topCardInnerTop;
    const trackH = viewH;

    const thumbH = Math.max(22 * DPR, (viewH / totalH) * trackH);
    const scrollProgress = (-this.topScrollOffset) / (totalH - viewH);
    const thumbY = trackY + scrollProgress * (trackH - thumbH);

    this.topScrollbarGfx.fillStyle(0x354258, 0.85);
    this.topScrollbarGfx.fillRoundedRect(scrollbarX, thumbY, 3 * DPR, thumbH, 1.5 * DPR);
  }

  createShop() {
    this.shopPage = this.add.container(0, 0).setVisible(false).setDepth(10);

    this.shopCardBg = this.add.rectangle(0, 0, 320, 180, 0x131722, 0.95);
    roundTarget(this, this.shopCardBg, {
      kind: 'rect',
      color: 0x131722,
      alpha: 0.95,
      radius: 16 * DPR,
      strokeColor: 0x252d40,
      strokeWidth: 1.5 * DPR,
    });

    this.shopTitle = this.add
      .text(0, -40, 'МАГАЗИН', {
        fontFamily: UI_FONT,
        fontSize: '20px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.shopText = this.add
      .text(0, 20, 'Раздел в разработке', {
        fontFamily: UI_FONT,
        fontSize: '15px',
        color: '#8898aa',
        align: 'center',
        lineSpacing: 6 * DPR,
      })
      .setOrigin(0.5);

    this.shopPage.add([this.shopCardBg, this.shopTitle, this.shopText]);
  }

  createTabs() {
    this.tabBar = this.add.container(0, 0).setDepth(10);
    this.tabInventory = this.makeTab('Турели', 'inventory');
    this.tabLobby = this.makeTab('Меню', 'lobby');
    this.tabTop = this.makeTab('Топ', 'top');
    this.tabShop = this.makeTab('Магазин', 'shop');
    this.tabBar.add([this.tabInventory, this.tabLobby, this.tabTop, this.tabShop]);
  }

  makeTab(label, key) {
    const tab = this.add
      .text(0, 0, label, {
        fontFamily: UI_FONT,
        fontSize: '14px',
        color: '#707e94',
        backgroundColor: '#161a26',
        padding: { x: 14 * DPR, y: 8 * DPR },
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    tab.tabKey = key;
    tab.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.selectTab(key);
    });
    roundTarget(this, tab, {
      color: 0x161a26,
      alpha: 0.95,
      radius: 10 * DPR,
      strokeColor: 0x252d40,
      strokeAlpha: 1,
      strokeWidth: 1 * DPR,
    });
    return tab;
  }

  selectTab(key) {
    this.currentTab = key;
    if (this.lobbyPage) this.lobbyPage.setVisible(key === 'lobby');
    if (this.inventoryPage) this.inventoryPage.setVisible(key === 'inventory');
    if (this.topPage) this.topPage.setVisible(key === 'top');
    if (this.shopPage) this.shopPage.setVisible(key === 'shop');

    if (this.topScrollZone && this.topScrollZone.input) {
      this.topScrollZone.input.enabled = (key === 'top');
    }

    const isLobby = key === 'lobby';
    if (this.title) this.title.setVisible(isLobby);

    const tabs = [this.tabInventory, this.tabLobby, this.tabTop, this.tabShop];
    for (const tab of tabs) {
      if (!tab) continue;
      const active = tab.tabKey === key;
      tab.setBackgroundColor('rgba(0,0,0,0)');
      tab.setColor(active ? '#ffffff' : '#707e94');
      if (tab._roundItem) {
        tab._roundItem.color = active ? 0xe63946 : 0x161a26;
        tab._roundItem.strokeColor = active ? 0xff6b7a : 0x252d40;
        tab._roundItem.strokeWidth = (active ? 1.5 : 1) * DPR;
      }
    }
    updateRoundBgs(this);
  }

  refreshProfile() {
    const nick = this.playerInfo ? this.playerInfo.nick : 'Гость';
    const role = this.playerRole || 'player';
    const prefix = this.roleLabel(role);

    if (this.playerNick) {
      this.playerNick.setText(prefix ? `${nick} · ${prefix}` : nick);
    }
    if (this.profileText) this.profileText.setText(prefix ? `${nick} · ${prefix}` : nick);

    const best = this.playerBest || { wave: 0, gold: 0 };
    if (this.statWaveVal) this.statWaveVal.setText(String(best.wave || 0));
    if (this.statGoldVal) this.statGoldVal.setText(String(best.gold || 0));
    if (this.statRankVal) this.statRankVal.setText(this.playerRank ? `#${this.playerRank}` : '—');

    if (this.bestText) {
      this.bestText.setText(
        best.wave > 0 ? `Волна ${best.wave} · ${best.gold} золота` : 'Пока нет результата'
      );
    }

    if (this.statsText) {
      this.statsText.setText(
        `Твой результат: волна ${best.wave || 0}  ·  ${best.gold || 0} золота  ·  Место: ${this.playerRank ? '#' + this.playerRank : '—'} из ${this.playersTotal || 0}`
      );
    }
    updateRoundBgs(this);
  }

  refreshTop() {
    if (!this.topListContainer) return;
    this.topListContainer.removeAll(true);

    if (!this.topList || this.topList.length === 0) {
      if (this.topEmptyText) {
        this.topEmptyText.setVisible(true).setText('Пока нет рекордов');
      }
      this.topContentH = 0;
      this.topMinScrollOffset = 0;
      this.applyTopScroll(0);
      return;
    }

    if (this.topEmptyText) this.topEmptyText.setVisible(false);

    const width = this.scale.width;
    const topCardW = this.topCardW || Math.min(width * 0.94, 550 * DPR);
    const rowW = topCardW - 24 * DPR;
    const rowH = 44 * DPR;
    const rowGap = 6 * DPR;
    const rowX = width / 2;

    const list = this.topList.slice(0, 10);
    list.forEach((item, index) => {
      const rowY = index * (rowH + rowGap) + rowH / 2;
      const rowContainer = this.add.container(rowX, rowY);

      // Фон строки
      const rowBg = this.add.graphics();
      const isTop3 = index < 3;
      rowBg.fillStyle(isTop3 ? 0x161d2b : 0x111622, 0.95);
      rowBg.fillRoundedRect(-rowW / 2, -rowH / 2, rowW, rowH, 8 * DPR);
      rowBg.lineStyle(1 * DPR, isTop3 ? 0x27354d : 0x1c2434, 0.85);
      rowBg.strokeRoundedRect(-rowW / 2, -rowH / 2, rowW, rowH, 8 * DPR);

      // Номер места
      const rankColor = index === 0 ? '#f1c40f' : index === 1 ? '#cbd5e1' : index === 2 ? '#e67e22' : '#707e94';
      const rankText = this.add
        .text(-rowW / 2 + 14 * DPR, 0, `#${index + 1}`, {
          fontFamily: UI_FONT,
          fontSize: `${Math.round(14 * DPR)}px`,
          color: rankColor,
          fontStyle: 'bold',
        })
        .setOrigin(0, 0.5);

      // Никнейм игрока
      const nickStr = item.nick || 'Игрок';
      const nickText = this.add
        .text(-rowW / 2 + 52 * DPR, 0, nickStr, {
          fontFamily: UI_FONT,
          fontSize: `${Math.round(14 * DPR)}px`,
          color: '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0, 0.5);

      // Ограничиваем ширину ника, чтобы не наезжал на показатели
      const maxNickW = Math.max(70 * DPR, rowW - 200 * DPR);
      if (nickText.width > maxNickW) {
        let short = nickStr;
        while (short.length > 2 && nickText.width > maxNickW) {
          short = short.slice(0, -1);
          nickText.setText(short + '…');
        }
      }

      // Показатели: волна и золото
      const statsStr = `Волна ${item.wave}  ·  ${item.gold} з.`;
      const statsText = this.add
        .text(rowW / 2 - 14 * DPR, 0, statsStr, {
          fontFamily: UI_FONT,
          fontSize: `${Math.round(13 * DPR)}px`,
          color: '#8b98aa',
        })
        .setOrigin(1, 0.5);

      rowContainer.add([rowBg, rankText, nickText, statsText]);
      this.topListContainer.add(rowContainer);
    });

    this.topContentH = list.length * (rowH + rowGap);
    this.topMinScrollOffset = Math.min(0, (this.topVisibleH || 0) - this.topContentH);
    this.applyTopScroll(this.topScrollOffset);
  }

  async loadPlayerData() {
    const initData = this.getInitData();
    if (initData) {
      try {
        const res = await fetch(`${API_BASE}/api/me`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.ok) {
            this.playerRole = data.role || 'player';
            this.playerBest = data.best || { wave: 0, gold: 0 };
            this.playerRank = data.rank || 0;
            this.playersTotal = data.total || 0;
            this.refreshProfile();
          }
        }
      } catch (error) {
        console.warn('Не удалось загрузить профиль:', error);
      }
    } else {
      this.refreshProfile();
    }

    try {
      const res = await fetch(`${API_BASE}/api/top`);
      if (res.ok) {
        const data = await res.json();
        this.topList = data.top || [];
        if (data.total) this.playersTotal = data.total;
        this.refreshTop();
        this.refreshProfile();
      }
    } catch (error) {
      console.warn('Не удалось загрузить топ:', error);
      if (this.topEmptyText) this.topEmptyText.setVisible(true).setText('Не удалось загрузить топ');
    }
  }

  layout() {
    const width = this.scale.width;
    const height = this.scale.height;
    const size = Math.min(width, height);

    this.background.setPosition(0, 0).setSize(width, height);

    // Фоновая графика / акцентная линия
    if (this.bgDecor) {
      this.bgDecor.clear();
      this.bgDecor.lineStyle(1 * DPR, 0x181e2b, 0.6);
      this.bgDecor.lineBetween(0, height * 0.88, width, height * 0.88);
    }

    // Заголовок
    if (this.title) {
      this.title.setPosition(width / 2, height * 0.16);
      this.title.setStyle({ fontSize: `${Math.max(22 * DPR, Math.round(size * 0.072))}px` });
    }

    // Карточка лобби
    const cardWidth = Math.min(width * 0.94, 460 * DPR);
    const cardHeight = Math.min(height * 0.38, 220 * DPR);
    const cardY = height * 0.42;
    const cardX = width / 2 - cardWidth / 2;
    const cardTop = cardY - cardHeight / 2;

    if (this.cardBg) {
      this.cardBg.clear();
      this.cardBg.fillStyle(0x131722, 0.95);
      this.cardBg.fillRoundedRect(cardX, cardTop, cardWidth, cardHeight, 16 * DPR);
      this.cardBg.lineStyle(1.5 * DPR, 0x242d40, 1);
      this.cardBg.strokeRoundedRect(cardX, cardTop, cardWidth, cardHeight, 16 * DPR);
    }

    if (this.playerNick) {
      this.playerNick.setPosition(width / 2, cardTop + 32 * DPR);
      this.playerNick.setStyle({ fontSize: `${Math.max(17 * DPR, Math.round(size * 0.05))}px` });
    }

    if (this.cardDivider) {
      this.cardDivider.clear();
      // Горизонтальный разделитель под ником
      this.cardDivider.lineStyle(1 * DPR, 0x1f2738, 0.8);
      this.cardDivider.lineBetween(cardX + 18 * DPR, cardTop + 64 * DPR, cardX + cardWidth - 18 * DPR, cardTop + 64 * DPR);
      // Тонкие вертикальные разделители колонок
      const colStep = cardWidth * 0.31;
      const vY1 = cardTop + 84 * DPR;
      const vY2 = cardTop + 186 * DPR;
      this.cardDivider.lineStyle(1 * DPR, 0x1a2130, 0.5);
      this.cardDivider.lineBetween(width / 2 - colStep / 2, vY1, width / 2 - colStep / 2, vY2);
      this.cardDivider.lineBetween(width / 2 + colStep / 2, vY1, width / 2 + colStep / 2, vY2);
    }

    // 3 блока показателей: РЕКОРД, ЗОЛОТО, ТОП
    const colStep = cardWidth * 0.31;
    const col1X = width / 2 - colStep;
    const col2X = width / 2;
    const col3X = width / 2 + colStep;
    const statLabelY = cardTop + 104 * DPR;
    const statValY = cardTop + 154 * DPR;

    const labelSize = `${Math.max(12 * DPR, Math.round(size * 0.028))}px`;
    const valSize = `${Math.max(22 * DPR, Math.round(size * 0.06))}px`;

    if (this.statWaveLabel) {
      this.statWaveLabel.setPosition(col1X, statLabelY).setStyle({ fontSize: labelSize });
      this.statWaveVal.setPosition(col1X, statValY).setStyle({ fontSize: valSize });
    }
    if (this.statGoldLabel) {
      this.statGoldLabel.setPosition(col2X, statLabelY).setStyle({ fontSize: labelSize });
      this.statGoldVal.setPosition(col2X, statValY).setStyle({ fontSize: valSize });
    }
    if (this.statRankLabel) {
      this.statRankLabel.setPosition(col3X, statLabelY).setStyle({ fontSize: labelSize });
      this.statRankVal.setPosition(col3X, statValY).setStyle({ fontSize: valSize });
    }

    // Кнопка В БОЙ
    if (this.playButton) {
      this.playButton.setPosition(width / 2, height * 0.70);
      this.playButton.setStyle({ fontSize: `${Math.max(18 * DPR, Math.round(size * 0.054))}px` });
    }

    // Инвентарь / Турели
    if (this.inventoryTitle) {
      this.inventoryTitle.setPosition(width / 2, height * 0.14);
      this.inventoryTitle.setStyle({ fontSize: `${Math.round(size * 0.048)}px` });
    }
    const rowScale = Math.min((width * 0.9) / 320, 1.3 * DPR);
    const rowStep = 76 * rowScale + 12 * DPR;
    const invStart = height * 0.24;
    this.inventoryRows.forEach((row, index) => {
      row.setPosition(width / 2, invStart + index * rowStep);
      row.setScale(rowScale);
    });

    // Топ игроков (широкая карточка с поддержкой скролла для 10+ игроков)
    if (this.topTitle) {
      this.topTitle.setPosition(width / 2, height * 0.11);
      this.topTitle.setStyle({ fontSize: `${Math.round(size * 0.048)}px` });
    }
    if (this.statsText) {
      this.statsText.setPosition(width / 2, height * 0.17);
      this.statsText.setStyle({
        fontSize: `${Math.max(11 * DPR, Math.round(size * 0.026))}px`,
        wordWrap: { width: Math.min(width * 0.9, 440 * DPR) },
      });
    }

    const topCardW = Math.min(width * 0.94, 550 * DPR);
    const topCardTop = height * 0.22;
    const topCardBottom = height * 0.88;
    const topCardH = topCardBottom - topCardTop;
    const topCardX = width / 2 - topCardW / 2;

    this.topCardW = topCardW;
    this.topCardH = topCardH;
    this.topCardX = topCardX;
    this.topCardTop = topCardTop;
    this.topCardInnerTop = topCardTop + 10 * DPR;
    this.topVisibleH = topCardH - 20 * DPR;
    this.topListBaseY = this.topCardInnerTop;

    if (this.topCardGfx) {
      this.topCardGfx.clear();
      this.topCardGfx.fillStyle(0x131722, 0.95);
      this.topCardGfx.fillRoundedRect(topCardX, topCardTop, topCardW, topCardH, 14 * DPR);
      this.topCardGfx.lineStyle(1.5 * DPR, 0x242d40, 1);
      this.topCardGfx.strokeRoundedRect(topCardX, topCardTop, topCardW, topCardH, 14 * DPR);
    }

    if (this.topMaskGfx) {
      this.topMaskGfx.clear();
      this.topMaskGfx.fillStyle(0xffffff);
      this.topMaskGfx.fillRect(topCardX + 2, topCardTop + 6 * DPR, topCardW - 4, topCardH - 12 * DPR);
    }

    if (this.topScrollZone) {
      this.topScrollZone.setPosition(topCardX, topCardTop).setSize(topCardW, topCardH);
    }

    if (this.topEmptyText) {
      this.topEmptyText.setPosition(width / 2, topCardTop + topCardH / 2);
    }

    this.refreshTop();

    // Магазин
    if (this.shopCardBg) {
      const shopCardW = Math.min(width * 0.88, 340 * DPR);
      this.shopCardBg.setPosition(width / 2, height * 0.44).setSize(shopCardW, 180 * DPR);
      this.shopTitle.setPosition(width / 2, height * 0.38).setStyle({ fontSize: `${Math.round(size * 0.042)}px` });
      this.shopText.setPosition(width / 2, height * 0.46).setStyle({
        fontSize: `${Math.round(size * 0.03)}px`,
        wordWrap: { width: shopCardW - 32 * DPR },
      });
    }

    // Вкладки внизу (порядок: Турели, Меню, Топ, Магазин)
    const tabY = height * 0.94;
    const tabWidths = [width * 0.15, width * 0.38, width * 0.62, width * 0.85];
    const tabFont = `${Math.max(12 * DPR, Math.round(size * 0.032))}px`;
    const tabs = [this.tabInventory, this.tabLobby, this.tabTop, this.tabShop];
    tabs.forEach((tab, i) => {
      if (tab) {
        tab.setPosition(tabWidths[i], tabY);
        tab.setStyle({ fontSize: tabFont });
      }
    });

    // Пересобираем скруглённые фоны кнопок под новый размер/шрифт.
    updateRoundBgs(this);
  }

  // Каждый кадр держим фоны в синхроне (размер/видимость).
  update() {
    updateRoundBgs(this);
  }

  getBaseTextureKey(typeKey) {
    const dirKey = `${typeKey}_base_${DIR_FORWARD}`;
    if (this.textures.exists(dirKey)) return dirKey;
    const key = `${typeKey}_base`;
    if (this.textures.exists(key)) return key;
    if (this.textures.exists(`template_base_${DIR_FORWARD}`)) return `template_base_${DIR_FORWARD}`;
    const fallback = TOWER_TYPES[typeKey].baseTexture;
    return this.textures.exists(fallback) ? fallback : null;
  }

  getWeaponTextureKey(typeKey, level) {
    const dirKey = `${typeKey}_gun_${level}_${DIR_FORWARD}`;
    if (this.textures.exists(dirKey)) return dirKey;
    for (let current = level; current >= 1; current--) {
      const key = `${typeKey}_${current}`;
      if (this.textures.exists(key)) return key;
    }
    return null;
  }

  initTelegram() {
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    if (!telegram) return;
    try {
      telegram.ready();
    } catch (error) {}
    try {
      telegram.expand();
    } catch (error) {}
  }

  getInitData() {
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    return telegram ? telegram.initData || '' : '';
  }

  getPlayerInfo() {
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    const user = telegram ? telegram.initDataUnsafe.user : null;
    if (user) {
      const nick = user.username
        ? '@' + user.username
        : [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Игрок';
      return { id: String(user.id), nick: nick };
    }
    return { id: 'test_player', nick: 'Гость' };
  }

  roleLabel(role) {
    if (role === 'creator') return 'создатель';
    if (role === 'tester') return 'тестер';
    return '';
  }
}

// ------------------------------ Игра ------------------------------
class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  // Предзагрузка изображений (вызывается Phaser автоматически до create).
  preload() {
    // Базовые картинки башен (запасной вариант, если нет спрайтов по уровням).
    this.load.image('tower', 'assets/tower.png' + ASSET_VER);
    this.load.image('tower_minigun', 'assets/tower_minigun.png' + ASSET_VER);

    // Картинки башен по уровням: assets/gunner_1.png ... gunner_5.png и т.д.
    // А также корпус: assets/gunner_base.png (не вращается).
    for (const key in TOWER_TYPES) {
        this.load.image(`${key}_base`, `assets/${key}_base.png${ASSET_VER}`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
          this.load.image(`${key}_${level}`, `assets/${key}_${level}.png${ASSET_VER}`);
      }
    }

    // Направленные спрайты (8 сторон): корпус и пушка. Если файлов ещё нет —
    // они просто не загрузятся, игра идёт на старых спрайтах (fallback).
    for (const key in TOWER_TYPES) {
      for (const dir of DIRECTIONS) {
        this.load.image(`${key}_base_${dir}`, `assets/${key}_base_${dir}.png${ASSET_VER}`);
        for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
          this.load.image(`${key}_gun_${level}_${dir}`, `assets/${key}_gun_${level}_${dir}.png${ASSET_VER}`);
        }
      }
    }

    // Спрайт-листы (одна картинка на все позы, раскладка 4x2).
    for (const key in TOWER_TYPES) {
      this.load.image(`${key}_base_sheet`, `assets/${key}_base_sheet.png${ASSET_VER}`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        this.load.image(`${key}_gun_${level}_sheet`, `assets/${key}_gun_${level}_sheet.png${ASSET_VER}`);
      }
    }
    // Общий шаблон-заглушка корпуса (для типов без своей модели).
    this.load.image('template_base_sheet', `assets/template_base_sheet.png${ASSET_VER}`);

    // Звуки (mp3). Если файла нет — игра просто идёт без этого звука.
    this.load.audio('sfx_shot', 'assets/shot.mp3' + ASSET_VER);
    this.load.audio('sfx_wave', 'assets/wave.mp3' + ASSET_VER);
    this.load.audio('sfx_gameover', 'assets/gameover.mp3' + ASSET_VER);

    // Если спрайта уровня/направления ещё нет — это не ошибка.
    this.load.on('loaderror', (file) => {
      if (
        file &&
        (/_\d+$/.test(file.key) ||
          /_base_[a-z]+$/.test(file.key) ||
          /_gun_\d+_[a-z]+$/.test(file.key) ||
          /_sheet$/.test(file.key))
      ) {
        return;
      }
      console.warn('Не загрузился файл:', file && file.key);
    });
  }

  create() {
    // Разворачиваем мини-апп на весь экран Telegram и определяем игрока.
    this.initTelegram();

    // Данные игрока и роль (creator / tester / player) — роль читается из Firebase.
    this.playerInfo = this.getPlayerInfo();
    this.playerRole = 'player';
    this.playerBest = { wave: 0, gold: 0 };

    // Состояние игрока (экономика и жизни).
    this.gold = START_GOLD;
    this.lives = START_LIVES;
    this.isGameOver = false;

    // Ускорение времени (для тестеров) и тип ввода (тач/мышь).
    this.timeScale = 1;
    this.infiniteLives = false;
    this.autoWave = false;
    this.isTouch = this.game.device.input.touch;
    this.infoEnemy = null;
    this.hoverEnemy = null;

    // Состояние волн.
    this.currentWave = 0;        // номер волны (до старта первой — 0)
    this.isWaveActive = false;   // идёт ли волна прямо сейчас
    this.enemiesLeftToSpawn = 0; // сколько врагов волны ещё не выпущено
    this.waveQueue = [];         // очередь типов врагов текущей волны
    this.waveSpawnTimer = null;  // таймер порционного спавна

    // Выбранная башня (для меню улучшения/продажи).
    this.selectedTower = null;
    // Тип башни, который строим по клику (переключается панелью внизу).
    // По умолчанию НИЧЕГО не выбрано — игрок выбирает башню сам.
    this.selectedTowerType = null;

    // Кэш замеров картинок: где у них непрозрачная часть и её центр.
    // Заполняется лениво (при первом использовании текстуры).
    this.visualCache = {};
    // Кэш единого размера направленных спрайтов (на набор направлений).
    this.dirSizeCache = {};

    // Башни хранятся списком (свободная установка, без привязки к клеткам).
    this.towers = [];

    // Состояние установки новой башни.
    this.isPlacing = false;

    // Маршрут врагов (источник истины) в world-координатах.
    this.route = ROUTE;

    // Списки живых врагов и снарядов.
    this.enemies = [];
    this.projectiles = [];

    // Слои: земля (0) → дорога (1) → кольцо радиуса (2) → fallback (3)
    // → мир (10+) → снаряды (500) → UI (900+).
    this.groundGraphics = this.add.graphics().setDepth(0);
    this.roadGraphics = this.add.graphics().setDepth(1);
    this.rangeGraphics = this.add.graphics().setDepth(2);
    this.towersGraphics = this.add.graphics().setDepth(3);

    // Пиксельный масштаб мира (iso) — константа, не зависит от экрана.
    this.cellSize = ISO_HW;
    this.offsetX = 0;
    this.offsetY = 0;

    // Нарезаем спрайт-листы (если есть) на отдельные направления.
    for (const key in TOWER_TYPES) {
      sliceSheet(this, `${key}_base_sheet`, `${key}_base`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        sliceSheet(this, `${key}_gun_${level}_sheet`, `${key}_gun_${level}`);
      }
    }
    sliceSheet(this, 'template_base_sheet', 'template_base');

    // Создаём UI (тексты поверх всего).
    this.createUI();

    // Первая отрисовка и подписка на изменение размера окна/экрана.
    this.layout();
    // Сначала снимаем старый обработчик (важно при рестарте сцены),
    // затем вешаем заново — иначе при перезапуске они накопятся.
    this.scale.off('resize', this.layout, this);
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
    this.updateUI();

    // Подгружаем роль игрока и досылаем несохранённые рекорды.
    this.loadPlayerRole();
    this.flushPendingScores();

    // ПКМ не должна открывать контекстное меню браузера.
    if (this.input.mouse) this.input.mouse.disableContextMenu();

    // Shift — режим «ставить подряд»: после постройки выбор не снимается.
    this.shiftKey = this.input.keyboard
      ? this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT)
      : null;

    // Горячие клавиши 1..N — выбор башни; повторное нажатие снимает выбор.
    if (this.input.keyboard) {
      this.input.keyboard.on('keydown', (event) => {
        if (this.isGameOver) return;

        // Клавиша X (в русской раскладке — Ч) продаёт выбранную башню.
        const key = (event.key || '').toLowerCase();
        if (key === 'x' || key === 'ч') {
          if (this.selectedTower) this.sellSelectedTower();
          return;
        }

        // Клавиша E (рус. У) улучшает выбранную башню.
        if (key === 'e' || key === 'у') {
          if (this.selectedTower) this.upgradeSelectedTower();
          return;
        }

        const index = parseInt(event.key, 10);
        if (!index) return;
        const keys = Object.keys(TOWER_TYPES);
        const typeKey = keys[index - 1];
        if (typeKey) this.selectTowerType(typeKey);
      });
    }

    // Управление указателем: клик — постройка/меню, потяг по пустому — камера.
    this.input.on('pointerdown', this.handlePointerDown, this);
    this.input.on('pointermove', this.handlePointerMove, this);
    this.input.on('pointerup', this.handlePointerUp, this);
    this.input.on('pointerupoutside', this.handlePointerUp, this);

    // Масштаб камеры: колесо (ПК) и два пальца (телефон: pinch + pan).
    this.setupZoom();

    // Волны запускаются вручную кнопкой "[ СТАРТ ВОЛНЫ ]".
  }

  // ------------------------- Интерфейс (UI) -------------------------
  // Создаём тексты: панель игрока, всплывающее предупреждение и экран Game Over.
  createUI() {
    // Панель с золотом и жизнями в правом верхнем углу.
    this.uiText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
        color: '#ffffff',
        align: 'right',
        lineSpacing: 6 * DPR,
        stroke: '#000000',
        strokeThickness: 4 * DPR,
      })
      .setOrigin(1, 0) // якорим к правому верхнему углу
      .setDepth(100);

    // Кнопка запуска следующей волны (левый верхний угол).
    this.startButton = this.add
      .text(0, 0, 'СТАРТ', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
        color: '#e63946',
        stroke: '#000000',
        strokeThickness: 3 * DPR,
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0) // верх по центру
      .setInteractive({ useHandCursor: true })
      .setDepth(100);

    // По клику/тапу запускаем следующую волну.
    this.startButton.on('pointerdown', (pointer, localX, localY, event) => {
      // Не даём клику уйти в сцену (иначе он мог бы поставить башню).
      if (event && event.stopPropagation) event.stopPropagation();
      this.startNextWave();
    });

    // Кнопка возврата в меню.
    this.menuButton = this.add
      .text(0, 0, '☰ Меню', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
        color: '#ffffff',
        backgroundColor: '#00000088',
        padding: { x: 10 * DPR, y: 6 * DPR },
        stroke: '#000000',
        strokeThickness: 3 * DPR,
      })
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(100);
    this.menuButton.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.scene.start('MenuScene');
    });



    // Всплывающее предупреждение (например, "не хватает золота").
    this.messageText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
        color: '#e63946',
        stroke: '#000000',
        strokeThickness: 5 * DPR,
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setVisible(false);

    // Затемнение экрана для Game Over.
    this.overlay = this.add
      .rectangle(0, 0, 1, 1, 0x000000, 0.6)
      .setOrigin(0, 0)
      .setDepth(90)
      .setVisible(false);

    // Крупный текст поражения.
    this.gameOverText = this.add
      .text(0, 0, 'ТЫ ПРОИГРАЛ', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '64px',
        color: '#e74c3c',
        stroke: '#000000',
        strokeThickness: 8 * DPR,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(101)
      .setVisible(false);

    // Кнопка перезапуска игры (появляется только на экране Game Over).
    this.restartButton = this.add
      .text(0, 0, 'ЗАНОВО', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '28px',
        color: '#ffffff',
        backgroundColor: '#e63946',
        padding: { x: 24 * DPR, y: 12 * DPR },
        stroke: '#000000',
        strokeThickness: 3 * DPR,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .setDepth(101)
      .setVisible(false);

    // По клику/тапу перезапускаем игру.
    this.restartButton.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.restartGame();
    });

    // Кнопка выхода в меню на экране поражения.
    this.gameOverMenuButton = this.add
      .text(0, 0, 'МЕНЮ', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '28px',
        color: '#ffffff',
        backgroundColor: '#3a3a3a',
        padding: { x: 24 * DPR, y: 12 * DPR },
        stroke: '#000000',
        strokeThickness: 3 * DPR,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .setDepth(101)
      .setVisible(false);
    this.gameOverMenuButton.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.scene.start('MenuScene');
    });

    // Меню башни (улучшение/продажа).
    // ВАЖНО: без контейнера — интерактив в контейнере со scrollFactor(0)
    // ломает хит-тест кликов. Делаем прямые объекты, зафиксированные на экране.
    this.towerMenuOffsets = { bg: 0, title: -45 * DPR, upgrade: 0, sell: 45 * DPR };

    this.towerMenuBg = this.add
      .rectangle(0, 0, 200 * DPR, 150 * DPR, 0x000000, 0.9)
      .setStrokeStyle(2 * DPR, TOWER_COLOR)
      .setDepth(102)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive();
    // Клик по фону меню не должен «проваливаться» в игровое поле.
    this.towerMenuBg.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
    });

    this.towerMenuTitle = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${13 * DPR}px`,
        color: '#ffffff',
        fontStyle: 'bold',
        align: 'center',
        lineSpacing: 4 * DPR,
      })
      .setOrigin(0.5)
      .setDepth(103)
      .setScrollFactor(0)
      .setVisible(false);

    this.towerMenuUpgrade = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${14 * DPR}px`,
        color: '#e63946',
      })
      .setOrigin(0.5)
      .setDepth(103)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });

    this.towerMenuSell = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${14 * DPR}px`,
        color: '#e74c3c',
      })
      .setOrigin(0.5)
      .setDepth(103)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });

    this.towerMenuParts = [
      this.towerMenuBg,
      this.towerMenuTitle,
      this.towerMenuUpgrade,
      this.towerMenuSell,
    ];

    this.towerMenuUpgrade.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.upgradeSelectedTower();
    });

    this.towerMenuSell.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.sellSelectedTower();
    });

    // Панель выбора башни для постройки (внизу экрана).
    this.createBuildMenu();

    // «Призрак» башни (корпус + пушка), следующий за указателем.
    // Изначально текстура-заглушка (gunner), т.к. башня не выбрана; при
    // выборе типа updateGhost подставит нужную картинку.
    const ghostType = TOWER_TYPES[this.selectedTowerType] || TOWER_TYPES.gunner;
    this.ghostBase = this.add.image(0, 0, ghostType.baseTexture).setAlpha(0.5);
    this.ghostWeapon = this.add.image(0, 0, ghostType.baseTexture).setAlpha(0.5);
    this.ghost = this.add
      .container(0, 0, [this.ghostBase, this.ghostWeapon])
      .setDepth(40)
      .setVisible(false);

    // Чит-меню — только для стаффа (тестер/создатель) и локали.
    this.cheatOpen = false;
    this.cheatButton = this.add
      .text(0, 0, '🛠', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${20 * DPR}px`,
        color: '#ffffff',
        backgroundColor: '#00000088',
        padding: { x: 10 * DPR, y: 6 * DPR },
        stroke: '#000000',
        strokeThickness: 3 * DPR,
      })
      .setOrigin(0, 0)
      .setDepth(100)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.cheatButton.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.toggleCheat();
    });

    const makeCheatButton = (label, handler) => {
      const t = this.add
        .text(0, 0, label, {
          fontFamily: 'Arial, sans-serif',
          fontSize: `${14 * DPR}px`,
          color: '#ffffff',
          backgroundColor: '#262626',
          padding: { x: 10 * DPR, y: 6 * DPR },
        })
        .setOrigin(0, 0)
        .setDepth(103)
        .setScrollFactor(0)
        .setVisible(false)
        .setInteractive({ useHandCursor: true });
      t.on('pointerdown', (pointer, localX, localY, event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        handler();
      });
      return t;
    };

    this.cheatGoldButton = makeCheatButton('💰 +1000 золота', () => {
      this.gold += 1000;
      this.updateUI();
      this.showMessage('+1000 золота');
    });
    this.cheatLivesButton = makeCheatButton('❤ Жизни ∞: выкл', () => this.toggleInfiniteLives());
    this.cheatSpeedButton = makeCheatButton('⏩ Скорость: x1', () => this.cycleSpeed());
    this.cheatKillButton = makeCheatButton('💀 Убить всех', () => this.killAllEnemies());
    this.cheatSkipButton = makeCheatButton('⏭ Авто-волна: выкл', () => this.toggleAutoWave());
    this.cheatParts = [
      this.cheatGoldButton,
      this.cheatLivesButton,
      this.cheatSpeedButton,
      this.cheatKillButton,
      this.cheatSkipButton,
    ];

    // Окошко с HP врага (наведение на ПК / тап по врагу на телефоне).
    this.enemyInfoBg = this.add
      .rectangle(0, 0, 170 * DPR, 74 * DPR, 0x000000, 0.85)
      .setStrokeStyle(2 * DPR, 0xffffff, 0.85)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false);
    this.enemyInfoText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${14 * DPR}px`,
        color: '#ffffff',
        align: 'center',
        lineSpacing: 3 * DPR,
      })
      .setOrigin(0.5)
      .setDepth(105)
      .setScrollFactor(0)
      .setVisible(false);

    // Жёлтый кружок вокруг врага (в мировых координатах, поверх юнитов).
    this.markerGraphics = this.add.graphics().setDepth(50);

    // Пунктирная вращающаяся грань радиуса атаки (белая).
    this.rangeDashGraphics = this.add.graphics().setDepth(2);
    this.rangePhase = 0;
    this.activeRange = null;

    // UI фиксируется на экране (не двигается и не масштабируется камерой).
    const fixedUI = [
      this.uiText,
      this.startButton,
      this.menuButton,
      this.messageText,
      this.overlay,
      this.gameOverText,
      this.restartButton,
      this.gameOverMenuButton,
      this.cheatButton,
      this.cheatGoldButton,
      this.cheatLivesButton,
      this.cheatSpeedButton,
      this.cheatKillButton,
      this.cheatSkipButton,
      this.enemyInfoBg,
      this.enemyInfoText,
    ];
    for (const obj of fixedUI) {
      if (obj) obj.setScrollFactor(0);
    }

    // Скруглённые фоны кнопок/окон.
    roundTarget(this, this.menuButton, { color: 0x2e2e2e, alpha: 1, radius: 12 * DPR });
    roundTarget(this, this.restartButton, { color: 0xe63946, alpha: 1, radius: 14 * DPR });
    roundTarget(this, this.gameOverMenuButton, { color: 0x2e2e2e, alpha: 1, radius: 14 * DPR });
    roundTarget(this, this.cheatButton, { color: 0x2e2e2e, alpha: 1, radius: 10 * DPR });
    for (const part of this.cheatParts) {
      roundTarget(this, part, { color: 0x3a3a3a, alpha: 1, radius: 10 * DPR });
    }
    // Окно прокачки — скруглённое.
    roundTarget(this, this.towerMenuBg, {
      kind: 'rect',
      color: 0x000000,
      alpha: 0.9,
      radius: 12 * DPR,
      strokeColor: TOWER_COLOR,
      strokeAlpha: 1,
      strokeWidth: 2 * DPR,
    });
  }

  // Обновляем текст панели при изменении волны/жизней/золота.
  updateUI() {
    const nick = this.playerInfo ? this.playerInfo.nick : 'Игрок';
    const prefix = this.roleLabel(this.playerRole);
    const nameLine = prefix ? `${nick} · ${prefix}` : nick;

    this.uiText.setText(
      `${nameLine}\nВолна: ${this.currentWave}\nЖизни: ${this.lives}\nЗолото: ${this.gold}`
    );
  }

  // Подпись роли.
  roleLabel(role) {
    if (role === 'creator') return 'создатель';
    if (role === 'tester') return 'тестер';
    return '';
  }

  // ---------------------- Чит-меню (стафф/локал) ----------------------
  updateStaffUI() {
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    const isBeta = host.includes('git-beta'); // тестовый деплой Vercel
    const staff =
      this.playerRole === 'tester' || this.playerRole === 'creator' || isLocal || isBeta;
    const show = staff && !this.isGameOver;
    if (this.cheatButton) this.cheatButton.setVisible(show);
    if (!show) {
      this.cheatOpen = false;
      if (this.cheatParts) for (const p of this.cheatParts) p.setVisible(false);
    } else if (this.cheatOpen && this.cheatParts) {
      for (const p of this.cheatParts) p.setVisible(true);
    }
  }

  toggleCheat() {
    this.cheatOpen = !this.cheatOpen;
    const show = this.cheatOpen && !this.isGameOver;
    if (this.cheatParts) for (const p of this.cheatParts) p.setVisible(show);
  }

  cycleSpeed() {
    const steps = [1, 2, 3, 5, 10];
    const idx = steps.indexOf(this.timeScale);
    this.timeScale = steps[(idx + 1) % steps.length];
    this.applyTimeScale();
  }

  applyTimeScale() {
    const s = this.timeScale;
    if (this.time) this.time.timeScale = s;
    if (this.tweens) this.tweens.timeScale = s;
    if (this.cheatSpeedButton) this.cheatSpeedButton.setText(`⏩ Скорость: x${s}`);
  }

  toggleInfiniteLives() {
    this.infiniteLives = !this.infiniteLives;
    if (this.cheatLivesButton) {
      this.cheatLivesButton.setText(`❤ Жизни ∞: ${this.infiniteLives ? 'вкл' : 'выкл'}`);
    }
  }

  killAllEnemies() {
    for (const enemy of [...this.enemies]) {
      if (enemy.active && !enemy.isDead) enemy.takeDamage(1e9);
    }
  }

  toggleAutoWave() {
    this.autoWave = !this.autoWave;
    if (this.cheatSkipButton) {
      this.cheatSkipButton.setText(`⏭ Авто-волна: ${this.autoWave ? 'вкл' : 'выкл'}`);
    }
  }

  // ---------------------- Информация о враге ----------------------
  // Враг под точкой (px, py — в world-пикселях).
  enemyAt(px, py) {
    for (const enemy of this.enemies) {
      if (!enemy.active || enemy.isDead) continue;
      const half = Math.max(enemy.width, enemy.height) / 2;
      if (Math.hypot(enemy.x - px, enemy.y - py) <= half) return enemy;
    }
    return null;
  }

  // world-пиксели -> экранные (UI) координаты.
  worldPxToScreen(px, py) {
    const cam = this.cameras.main;
    const tl = cam.getWorldPoint(0, 0);
    return { x: (px - tl.x) * cam.zoom, y: (py - tl.y) * cam.zoom };
  }

  showEnemyInfo(enemy) {
    this.infoEnemy = enemy;
    if (this.enemyInfoBg) this.enemyInfoBg.setVisible(true);
    if (this.enemyInfoText) this.enemyInfoText.setVisible(true);
    this.updateEnemyInfo();
  }

  hideEnemyInfo() {
    this.infoEnemy = null;
    if (this.enemyInfoBg) this.enemyInfoBg.setVisible(false);
    if (this.enemyInfoText) this.enemyInfoText.setVisible(false);
    this.clearEnemyMarker();
  }

  updateEnemyInfo() {
    // Жёлтый кружок: цель клика или (на ПК) наведённый враг.
    const marker =
      this.infoEnemy && this.infoEnemy.active && !this.infoEnemy.isDead
        ? this.infoEnemy
        : this.hoverEnemy && this.hoverEnemy.active && !this.hoverEnemy.isDead
          ? this.hoverEnemy
          : null;
    if (marker) this.drawEnemyMarker(marker);
    else this.clearEnemyMarker();

    // Плашка с HP (по клику) — сбоку экрана, позиция задаётся в layoutUI.
    const e = this.infoEnemy;
    if (e && e.active && !e.isDead) {
      const NAMES = {
        normal: 'Обычный',
        fast: 'Быстрый',
        armored: 'Бронированный',
        tank: 'Танк',
        splitter: 'Делящийся',
        small: 'Мелкий',
        shielded: 'Щитоносец',
        boss: 'Босс',
      };
      let text = `${NAMES[e.typeKey] || e.typeKey}\nHP ${Math.max(0, Math.ceil(e.hp))}/${e.maxHp}`;
      if (e.shield > 0) text += `\nЩит ${Math.ceil(e.shield)}`;
      this.enemyInfoText.setText(text);
      this.enemyInfoBg.setVisible(true);
      this.enemyInfoText.setVisible(true);
    } else {
      this.infoEnemy = null;
      this.enemyInfoBg.setVisible(false);
      this.enemyInfoText.setVisible(false);
    }
  }

  // ---------------------- Маркер врага (жёлтый кружок) ----------------------
  drawEnemyMarker(enemy) {
    const g = this.markerGraphics;
    if (!g || !enemy) return;
    g.clear();
    const r = Math.max(enemy.displayWidth, enemy.displayHeight) / 2 + 5;
    g.lineStyle(3, 0xffe600, 0.95);
    g.strokeCircle(enemy.x, enemy.y, r);
  }

  clearEnemyMarker() {
    if (this.markerGraphics) this.markerGraphics.clear();
  }





  // Строка initData из Telegram — именно её проверяет сервер.
  getInitData() {
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    return telegram ? telegram.initData || '' : '';
  }

  // Роль игрока берём у сервера после проверки initData.
  async loadPlayerRole() {
    const initData = this.getInitData();
    if (!initData) return;

    try {
      const response = await fetch(`${API_BASE}/api/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      if (!response.ok) return;

      const data = await response.json();
      if (!data.ok) return;

      this.playerRole = data.role || 'player';
      if (data.best) this.playerBest = data.best;
      this.updateUI();
      this.updateStaffUI();
    } catch (error) {
      console.warn('Не удалось загрузить роль:', error);
    }
  }

  // Показываем всплывающее сообщение и плавно гасим его.
  showMessage(text) {
    if (this.messageTween) this.messageTween.stop();

    this.messageText.setText(text).setAlpha(1).setVisible(true);
    this.messageTween = this.tweens.add({
      targets: this.messageText,
      alpha: 0,
      delay: 700,
      duration: 600,
      onComplete: () => this.messageText.setVisible(false),
    });
  }

  // Проиграть звук, если файл реально загрузился (иначе — тишина).
  playSfx(key, volume = 0.5) {
    if (this.cache.audio.exists(key)) {
      this.sound.play(key, { volume });
    }
  }

  // Экран поражения.
  showGameOver() {
    this.overlay.setVisible(true);
    this.gameOverText.setVisible(true);
    this.startButton.setVisible(false); // убираем кнопку старта волны
    this.uiText.setVisible(false); // убираем панель игрока (ник/волна/жизни/золото)
    this.menuButton.setVisible(false); // убираем верхнюю кнопку меню
    this.restartButton.setVisible(true); // показываем кнопку перезапуска
    this.gameOverMenuButton.setVisible(true); // и кнопку меню
    this.closeTowerMenu(); // прячем меню башни, если оно было открыто
    this.setBuildMenuVisible(false); // прячем панель постройки
    this.ghost.setVisible(false); // прячем призрак башни
    this.clearRangeRing(); // убираем кольцо радиуса
    this.hideEnemyInfo();
    this.updateStaffUI(); // прячем кнопку ускорения

    // Небольшой эффект появления.
    this.gameOverText.setScale(0.5);
    this.tweens.add({
      targets: this.gameOverText,
      scale: 1,
      duration: 300,
      ease: 'Back.easeOut',
    });
  }

  // Полный перезапуск игры без перезагрузки страницы.
  // scene.restart() заново вызывает create() и сбрасывает всё состояние.
  restartGame() {
    this.scene.restart();
  }

  // ------------------------- Меню башни -------------------------
  // Открыть меню выбранной башни.
  openTowerMenu(tower) {
    this.selectedTower = tower;
    this.hideEnemyInfo();
    // Показываем все части меню.
    for (const part of this.towerMenuParts) part.setVisible(true);
    this.refreshTowerMenu();
    this.positionTowerMenu();
    this.showRangeRingForTower(tower);
  }

  // Закрыть меню башни.
  closeTowerMenu() {
    this.selectedTower = null;
    if (this.towerMenuParts) {
      for (const part of this.towerMenuParts) part.setVisible(false);
    }
    this.clearRangeRing();
  }

  // Обновить тексты меню по текущей башне.
  refreshTowerMenu() {
    const tower = this.selectedTower;
    if (!tower) return;

    this.towerMenuUpgrade.setVisible(true);
    this.towerMenuTitle.setText(
      `${tower.config.name} · ур. ${tower.level}\n` +
        `Радиус ${tower.range.toFixed(1)} · ${tower.fireRate.toFixed(1)}/с · точн. ${Math.round(
          tower.accuracy * 100
        )}%`
    );

    if (tower.canUpgrade()) {
      this.towerMenuUpgrade.setText(`Улучшить (${tower.getUpgradeCost()})`).setColor('#e63946');
    } else {
      this.towerMenuUpgrade.setText('МАКС. УРОВЕНЬ').setColor('#7f8c8d');
    }

    this.towerMenuSell.setText(`✖ Продать (+${tower.getSellValue()})`);
  }

  // Расположить меню рядом с башней, не выпуская его за края экрана.
  positionTowerMenu() {
    const tower = this.selectedTower;
    if (!tower) return;

    const width = this.scale.width;
    const height = this.scale.height;
    const halfW = 100 * DPR; // половина ширины фона меню (200 / 2)
    const halfH = 75 * DPR;  // половина высоты фона меню (150 / 2)
    const margin = 8 * DPR;

    // Угол окна (верх-лево) — в точке нажатия (или у башни).
    const anchor = this.menuAnchor || this.worldToUI(tower.gx, tower.gy);
    const x = Phaser.Math.Clamp(anchor.x + halfW, halfW + margin, width - halfW - margin);
    const y = Phaser.Math.Clamp(anchor.y + halfH, halfH + margin, height - halfH - margin);

    const off = this.towerMenuOffsets;
    this.towerMenuBg.setPosition(x, y + off.bg);
    this.towerMenuTitle.setPosition(x, y + off.title);
    this.towerMenuUpgrade.setPosition(x, y + off.upgrade);
    this.towerMenuSell.setPosition(x, y + off.sell);
  }

  // Улучшить выбранную башню за золото.
  upgradeSelectedTower() {
    const tower = this.selectedTower;
    if (!tower || !tower.canUpgrade()) return;

    const cost = tower.getUpgradeCost();
    if (this.gold < cost) {
      this.showMessage(`Не хватает золота! Нужно ${cost}`);
      return;
    }

    this.gold -= cost;
    tower.upgrade(cost);
    this.refreshTowerSprite(tower); // меняем картинку на спрайт нового уровня
    this.drawTowers();
    this.refreshTowerMenu();
    this.showRangeRingForTower(tower); // радиус вырос — обновляем кольцо
    this.updateUI();
  }

  // Продать выбранную башню и вернуть часть золота.
  sellSelectedTower() {
    const tower = this.selectedTower;
    if (!tower) return;

    this.gold += tower.getSellValue();
    const index = this.towers.indexOf(tower);
    if (index !== -1) this.towers.splice(index, 1);
    this.destroyTowerSprite(tower);
    this.drawTowers();
    this.closeTowerMenu();
    this.updateUI();
  }

  // ------------------------- Панель постройки -------------------------
  // Создаём кнопки выбора типа башни (внизу экрана).
  createBuildMenu() {
    // Без контейнеров: интерактив в контейнере со scrollFactor(0) ломает клики.
    // Каждая кнопка = отдельные объекты, зафиксированные на экране.
    this.buildButtons = {};
    this.buildButtonWidth = 105 * DPR;
    this.buildGap = 8 * DPR;

    const buttonWidth = this.buildButtonWidth;

    Object.keys(TOWER_TYPES).forEach((key) => {
      const type = TOWER_TYPES[key];

      const bg = this.add
        .rectangle(0, 0, buttonWidth, 90 * DPR, 0x232323, 1)
        .setStrokeStyle(2, TOWER_COLOR, 0.9)
        .setDepth(100)
        .setScrollFactor(0)
        .setInteractive({ useHandCursor: true });

      roundTarget(this, bg, {
        kind: 'rect',
        color: 0x232323,
        alpha: 1,
        radius: 12 * DPR,
        strokeColor: TOWER_COLOR,
        strokeAlpha: 0.9,
        strokeWidth: 2 * DPR,
      });

      bg.on('pointerdown', (pointer, localX, localY, event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.selectTowerType(key);
      });

      // Иконка = корпус + пушка 1-го уровня (направление по умолчанию — вперёд).
      const base = this.resolveBase(key, DIR_FORWARD);
      const baseKey = (base && base.key) || type.texture;
      const iconBase = this.add
        .image(0, 0, baseKey)
        .setDisplaySize(34 * DPR, 34 * DPR)
        .setDepth(101)
        .setScrollFactor(0);
      const gun = this.resolveGun(key, 1, DIR_FORWARD);
      const iconWeapon = gun
        ? this.add.image(0, 0, gun.key).setDisplaySize(34 * DPR, 34 * DPR).setDepth(101).setScrollFactor(0)
        : null;

      const label = this.add
        .text(0, 0, `${type.name} · ${type.cost}`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: `${13 * DPR}px`,
          color: '#ffffff',
        })
        .setOrigin(0.5)
        .setDepth(101)
        .setScrollFactor(0);

      this.buildButtons[key] = {
        bg: bg,
        iconBase: iconBase,
        iconWeapon: iconWeapon,
        label: label,
        type: type,
      };
    });

    this.refreshBuildMenu();
  }

  // Выбрать тип башни для постройки. Повторный клик по выбранной — снять выбор.
  selectTowerType(key) {
    this.selectedTowerType = this.selectedTowerType === key ? null : key;
    this.refreshBuildMenu();
    if (!this.selectedTowerType) this.cancelPlacement();
  }

  // Снять выбор башни (тогда клик по полю ничего не строит).
  clearTowerSelection() {
    this.selectedTowerType = null;
    this.refreshBuildMenu();
    this.cancelPlacement();
  }

  // Подсветить выбранную кнопку панели.
  refreshBuildMenu() {
    if (!this.buildButtons) return;
    for (const key in this.buildButtons) {
      const selected = key === this.selectedTowerType;
      const bg = this.buildButtons[key].bg;
      if (bg._roundItem) {
        bg._roundItem.strokeColor = selected ? TOWER_COLOR : 0xffffff;
        bg._roundItem.strokeAlpha = selected ? 1 : 0.4;
        bg._roundItem.strokeWidth = (selected ? 3 : 2) * DPR;
      }
    }
    updateRoundBgs(this);
  }

  // Расположить кнопки панели постройки внизу экрана.
  layoutBuildMenu(width, height) {
    const keys = Object.keys(this.buildButtons);
    const buttonWidth = this.buildButtonWidth;
    const gap = this.buildGap;

    const totalWidth = keys.length * buttonWidth + (keys.length - 1) * gap;
    const startX = width / 2 - totalWidth / 2 + buttonWidth / 2;
    const y = height - 60 * DPR;

    keys.forEach((key, index) => {
      const x = startX + index * (buttonWidth + gap);
      const b = this.buildButtons[key];
      b.bg.setPosition(x, y);
      b.iconBase.setPosition(x, y - 14 * DPR);
      if (b.iconWeapon) b.iconWeapon.setPosition(x, y - 14 * DPR);
      b.label.setPosition(x, y + 26 * DPR);
    });
  }

  // Показать/скрыть панель постройки целиком (например, на экране поражения).
  setBuildMenuVisible(visible) {
    if (!this.buildButtons) return;
    for (const key in this.buildButtons) {
      const b = this.buildButtons[key];
      b.bg.setVisible(visible);
      b.iconBase.setVisible(visible);
      if (b.iconWeapon) b.iconWeapon.setVisible(visible);
      b.label.setVisible(visible);
    }
  }

  // ------------------------- Игровые события -------------------------
  // Враг убит башней — начисляем золото по типу врага.
  onEnemyKilled(enemy) {
    this.gold += enemy.reward;
    this.updateUI();
  }

  // Разделяющийся враг умер — выпускаем мелких в той же точке пути.
  onEnemySplit(parent) {
    const typeKey = parent.config.splitInto;
    if (!typeKey) return;

    const base = ENEMY_TYPES[typeKey];
    const scale = this.enemyHpScale(this.currentWave);
    const count = parent.config.splitCount || 2;

    for (let i = 0; i < count; i++) {
      const hp = Math.round(base.hp * scale);
      const child = new Enemy(this, this.route, typeKey, hp, 0);
      // Ставим детей туда же, где погиб родитель (чуть вразброс).
      child.segment = parent.segment;
      child.progress = Math.max(0, parent.progress - i * 0.08);
      this.enemies.push(child);
    }
  }

  // Враг дошёл до конца дороги — отнимаем жизни, при 0 запускаем Game Over.
  onEnemyReachedEnd(enemy) {
    if (this.isGameOver) return;
    if (this.infiniteLives) return; // чит: жизни не тратятся

    const damage = (enemy && enemy.config.livesDamage) || 1;
    this.lives = Math.max(0, this.lives - damage);
    this.updateUI();
    console.log(`Враг дошёл до конца дороги! Осталось жизней: ${this.lives}`);

    if (this.lives <= 0) this.triggerGameOver();
  }

  // Останавливаем игру и показываем экран поражения.
  triggerGameOver() {
    if (this.isGameOver) return;

    this.isGameOver = true;
    this.playSfx('sfx_gameover', 0.6);
    if (this.waveSpawnTimer) this.waveSpawnTimer.remove(false); // прекращаем спавн
    this.showGameOver();
    console.log('GAME OVER');

    // Отправляем рекорд в облако (не ждём ответа, чтобы игра не «зависла»).
    this.saveRecord();
  }

  // Инициализация Telegram Mini App (если игра открыта внутри Telegram).
  initTelegram() {
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    if (!telegram) return;

    telegram.ready(); // сообщаем Telegram, что приложение готово
    telegram.expand(); // разворачиваем на весь экран

    // Пробуем полноэкранный режим и фиксацию ориентации (если поддерживается).
    try {
      if (telegram.requestFullscreen) telegram.requestFullscreen();
    } catch (error) {
      /* не критично */
    }
    try {
      if (telegram.lockOrientation) telegram.lockOrientation();
    } catch (error) {
      /* не критично */
    }
  }

  // Данные игрока: id (для документа) и ник (из профиля Telegram).
  getPlayerInfo() {
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    const user = telegram ? telegram.initDataUnsafe.user : null;

    // Внутри Telegram — ник и id из профиля пользователя.
    if (user) {
      const nick = user.username
        ? '@' + user.username
        : [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Игрок';
      return { id: String(user.id), nick: nick };
    }

    // Игра открыта в обычном браузере — считаем гостем.
    return { id: 'test_player', nick: 'Гость' };
  }

  // Сохраняем рекорд ЧЕРЕЗ СЕРВЕР. Клиент напрямую в Firestore не пишет:
  // сервер проверит initData, сам определит Telegram ID и запишет рекорд.
  async saveRecord() {
    const payload = {
      initData: this.getInitData(),
      wave: this.currentWave,
      gold: this.gold,
    };

    const sent = await this.sendScore(payload);
    if (sent) {
      console.log('Рекорд сохранён на сервере!');
      return;
    }

    // Сервер недоступен — не теряем результат: отправим позже.
    this.queueScore(payload);
    console.log('Сервер недоступен — рекорд сохранён локально и отправится позже.');
  }

  // Отправка одного рекорда на сервер. true — если сервер принял.
  async sendScore(payload) {
    try {
      const response = await fetch(`${API_BASE}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  // Кладём несохранённый рекорд в локальную очередь (localStorage).
  queueScore(payload) {
    try {
      const queue = JSON.parse(localStorage.getItem('td_pending_scores') || '[]');
      queue.push(payload);
      localStorage.setItem('td_pending_scores', JSON.stringify(queue));
    } catch (error) {
      console.warn('Не удалось сохранить рекорд локально:', error);
    }
  }

  // Пытаемся дослать все накопившиеся рекорды.
  async flushPendingScores() {
    let queue = [];
    try {
      queue = JSON.parse(localStorage.getItem('td_pending_scores') || '[]');
    } catch (error) {
      queue = [];
    }
    if (queue.length === 0) return;

    const remaining = [];
    for (const payload of queue) {
      const sent = await this.sendScore(payload);
      if (!sent) remaining.push(payload);
    }

    try {
      localStorage.setItem('td_pending_scores', JSON.stringify(remaining));
    } catch (error) {
      /* ignore */
    }
  }

  // Пересчёт размеров и перерисовка под текущий размер экрана.
  // Вызывается при старте и при каждом ресайзе (поворот телефона и т.п.).
  layout() {
    const width = this.scale.width;
    const height = this.scale.height;

    // Пиксельный масштаб мира — константа (iso), не зависит от экрана.
    this.cellSize = ISO_HW;

    this.drawGround();
    this.drawRoad();
    this.drawTowers();
    this.layoutTowerSprites();
    this.layoutUI(width, height);
    this.setupCamera();
  }

  // Камера работает поверх world-space (iso-пикселей).
  setupCamera() {
    const cam = this.cameras.main;
    const center = worldToScreen(WORLD_SIZE / 2, WORLD_SIZE / 2);
    cam.centerOn(center.x, center.y);
    if (!this.cameraInitialized) {
      cam.setZoom(this.fitZoom());
      this.cameraInitialized = true;
    }
  }

  // Зум, при котором карта целиком влезает в экран.
  fitZoom() {
    const width = this.scale.width;
    const height = this.scale.height;
    const mapW = WORLD_SIZE * ISO_HW * 2;
    const mapH = WORLD_SIZE * ISO_HH * 2;
    return Math.min(width / mapW, height / mapH) * 0.95;
  }

  minZoom() {
    // Даём отдалять карту дальше «целиком в экране» (иначе на ПК зум
    // не отдаляется вообще: стартовый зум уже равен минимуму).
    return this.fitZoom() * 0.5;
  }

  maxZoom() {
    return this.fitZoom() * 4;
  }

  // Экранные (UI) координаты из world — для меню, привязанных к башне.
  worldToUI(wx, wy) {
    const cam = this.cameras.main;
    const topLeft = cam.getWorldPoint(0, 0);
    const p = worldToScreen(wx, wy);
    return { x: (p.x - topLeft.x) * cam.zoom, y: (p.y - topLeft.y) * cam.zoom };
  }

  // Управление зумом/пэном: колесо (ПК) и два пальца (тач).
  setupZoom() {
    const cam = this.cameras.main;

    this.input.on('wheel', (pointer, gameObjects, dx, dy) => {
      const factor = dy > 0 ? 0.9 : 1.1;
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, this.minZoom(), this.maxZoom()));
    });

    this.input.addPointer(1);
    this.pinchDistance = 0;
    this.pinchActive = false;
    this.pinchMid = { x: 0, y: 0 };

    // Состояние панорамирования одним пальцем.
    this.panArmed = false;
    this.panActive = false;
    this.panStart = { x: 0, y: 0 };
    this.panLast = { x: 0, y: 0 };

    this.input.on('pointermove', () => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;

      if (p1.isDown && p2.isDown) {
        const distance = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;

        if (this.pinchActive) {
          // Зум по изменению расстояния.
          if (this.pinchDistance > 0) {
            const next = Phaser.Math.Clamp(
              cam.zoom * (distance / this.pinchDistance),
              this.minZoom(),
              this.maxZoom()
            );
            cam.setZoom(next);
          }
          // Пан по движению середины.
          cam.scrollX -= (midX - this.pinchMid.x) / cam.zoom;
          cam.scrollY -= (midY - this.pinchMid.y) / cam.zoom;
        }

        this.pinchDistance = distance;
        this.pinchMid.x = midX;
        this.pinchMid.y = midY;
        this.pinchActive = true;

        // Два пальца — режим пинча, одиночный пан выключаем.
        this.panArmed = false;
        this.panActive = false;
      } else {
        this.pinchActive = false;
        this.pinchDistance = 0;
      }
    });

    // Сброс пинча при отпускании пальца: иначе следующий жест 2 пальцами
    // берёт устаревшие distance/mid из прошлого раза и резко дёргает камеру.
    const resetPinch = () => {
      this.pinchActive = false;
      this.pinchDistance = 0;
    };
    this.input.on('pointerup', resetPinch);
    this.input.on('pointerupoutside', resetPinch);
  }

  // Позиционируем элементы интерфейса под новый размер экрана.
  layoutUI(width, height) {
    const pad = Math.max(10 * DPR, Math.min(width, height) * 0.03);
    const uiSize = Math.max(16 * DPR, Math.min(width, height) * 0.05);

    this.uiText.setPosition(width - pad, pad);
    this.uiText.setStyle({ fontSize: `${Math.round(uiSize)}px` });
    this.uiText.setVisible(!this.isGameOver);

    // Кнопка старта волны — сверху по центру. На телефоне опускаем ниже,
    // чтобы не упиралась в шапку Telegram / верхний отступ.
    const isTouch = this.game.device.input.touch;
    const startY = isTouch ? pad + uiSize * 2.5 : pad;
    this.startButton.setPosition(width / 2, startY);
    this.startButton.setStyle({ fontSize: `${Math.round(uiSize)}px` });
    this.startButton.setVisible(!this.isWaveActive && !this.isGameOver);

    // Кнопка меню — вверху слева.
    this.menuButton.setPosition(pad, pad);
    this.menuButton.setStyle({ fontSize: `${Math.round(uiSize * 0.9)}px` });
    this.menuButton.setVisible(!this.isGameOver);

    // Чит-меню (стафф/локал) — слева, под кнопкой меню.
    if (this.cheatButton) {
      this.cheatButton.setPosition(pad, pad + uiSize * 1.9);
      this.cheatButton.setStyle({ fontSize: `${Math.round(uiSize * 0.9)}px` });
      const cy = pad + uiSize * 3.2;
      const rowH = uiSize * 1.6;
      this.cheatParts.forEach((p, i) => {
        p.setPosition(pad, cy + i * rowH);
        p.setStyle({ fontSize: `${Math.round(uiSize * 0.6)}px` });
      });
      this.updateStaffUI();
    }

    this.messageText.setPosition(width / 2, height * 0.8);
    this.messageText.setStyle({ fontSize: `${Math.round(uiSize * 0.9)}px` });

    this.overlay.setSize(width, height);
    this.overlay.setPosition(0, 0);

    // Плашка HP врага (по клику) — сбоку экрана.
    if (this.enemyInfoBg) {
      const ibw = this.enemyInfoBg.width;
      const ix = width - ibw / 2 - pad;
      const iy = height * 0.5;
      this.enemyInfoBg.setPosition(ix, iy);
      this.enemyInfoText.setPosition(ix, iy);
    }

    this.gameOverText.setPosition(width / 2, height / 2);
    this.gameOverText.setStyle({ fontSize: `${Math.round(Math.min(width, height) * 0.13)}px` });

    // Кнопка перезапуска — под надписью; видна только на проигрыше.
    this.restartButton.setPosition(width / 2, height / 2 + Math.min(width, height) * 0.16);
    this.restartButton.setStyle({ fontSize: `${Math.round(Math.min(width, height) * 0.05)}px` });
    this.restartButton.setVisible(this.isGameOver);

    // Кнопка «Меню» на экране поражения.
    this.gameOverMenuButton.setPosition(width / 2, height / 2 + Math.min(width, height) * 0.26);
    this.gameOverMenuButton.setStyle({
      fontSize: `${Math.round(Math.min(width, height) * 0.05)}px`,
    });
    this.gameOverMenuButton.setVisible(this.isGameOver);

    // Если меню башни открыто — пересчитываем позицию и кольцо под новый размер.
    if (this.selectedTower) {
      this.positionTowerMenu();
      this.showRangeRingForTower(this.selectedTower);
    }

    // Панель постройки башен.
    this.layoutBuildMenu(width, height);
    this.setBuildMenuVisible(!this.isGameOver);

    // Пересобираем скруглённые фоны кнопок.
    updateRoundBgs(this);
  }

  // Земля — большой изометрический ромб (без видимой квадратной сетки).
  drawGround() {
    const g = this.groundGraphics;
    g.clear();
    const corners = [
      worldToScreen(0, 0),
      worldToScreen(WORLD_SIZE, 0),
      worldToScreen(WORLD_SIZE, WORLD_SIZE),
      worldToScreen(0, WORLD_SIZE),
    ];
    g.fillStyle(CELL_COLOR, 1);
    g.fillPoints(corners, true);
    g.lineStyle(3, GRID_LINE_COLOR, 1);
    g.strokePoints(corners, true);
  }

  // Дорога — одна цельная изополоса вдоль полилинии Route.
  // Углы сшиваем «митром» (без зубцов/щелей), концы уводим за границу поля.
  // Это ТОЛЬКО отрисовка: Route, движение и коллизии не меняются.
  drawRoad() {
    const g = this.roadGraphics;
    g.clear();

    const src = this.route.waypoints;
    if (!src || src.length < 2) return;

    const half = ROAD_WIDTH / 2;
    const norm = (x, y) => {
      const l = Math.hypot(x, y) || 1;
      return { x: x / l, y: y / l };
    };

    // Копия точек маршрута; первый и последний отрезки удлиняем наружу.
    const pts = src.map((p) => ({ x: p.x, y: p.y }));
    const extend = 1.0;
    const first = norm(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    pts[0] = { x: pts[0].x - first.x * extend, y: pts[0].y - first.y * extend };
    const lastDir = norm(
      pts[pts.length - 1].x - pts[pts.length - 2].x,
      pts[pts.length - 1].y - pts[pts.length - 2].y
    );
    pts[pts.length - 1] = {
      x: pts[pts.length - 1].x + lastDir.x * extend,
      y: pts[pts.length - 1].y + lastDir.y * extend,
    };

    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
      let ox;
      let oy;
      if (i === 0) {
        const d = norm(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        ox = -d.y;
        oy = d.x;
      } else if (i === pts.length - 1) {
        const d = norm(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        ox = -d.y;
        oy = d.x;
      } else {
        // Биссектриса нормалей соседних отрезков + компенсация длины (митр).
        const d0 = norm(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        const d1 = norm(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        const n0x = -d0.y;
        const n0y = d0.x;
        const n1x = -d1.y;
        const n1y = d1.x;
        let mx = n0x + n1x;
        let my = n0y + n1y;
        const ml = Math.hypot(mx, my) || 1;
        mx /= ml;
        my /= ml;
        const cosHalf = mx * n0x + my * n0y;
        const scale = Phaser.Math.Clamp(cosHalf !== 0 ? 1 / cosHalf : 1, -3, 3);
        ox = mx * scale;
        oy = my * scale;
      }
      left.push(worldToScreen(pts[i].x + ox * half, pts[i].y + oy * half));
      right.push(worldToScreen(pts[i].x - ox * half, pts[i].y - oy * half));
    }

    right.reverse();
    g.fillStyle(ROAD_COLOR, 1);
    g.fillPoints([...left, ...right], true);
  }

  // Рисуем башни по массиву towers.
  drawTowers() {
    const g = this.towersGraphics;
    g.clear();

    for (const tower of this.towers) {
      // Запасной вариант: если картинки нет — рисуем кружок цветом типа.
      if (!this.textures.exists(tower.config.texture)) {
        const pos = tower.getPosition();
        const half = (this.cellSize * tower.config.footprint) / 2;
        g.fillStyle(tower.config.color, 1);
        g.fillCircle(pos.x, pos.y, half);
      }
    }
  }

  // ------------------------- Спрайты башен -------------------------
  // Создаём корпус и пушку башни.
  createTowerSprite(tower) {
    const pos = tower.getPosition();
    const depth = 10 + (tower.gx + tower.gy) * 0.01; // глубина по world (iso)

    const base = this.resolveBase(tower.typeKey, tower.baseDir);
    if (base) {
      tower.baseSprite = this.add.image(pos.x, pos.y, base.key).setDepth(depth);
      this.applyBaseVisual(tower.baseSprite, tower.typeKey, base);
    }

    const gun = this.resolveGun(tower.typeKey, tower.level, tower.aimDir);
    if (gun) {
      tower.sprite = this.add.image(pos.x, pos.y, gun.key).setDepth(depth + 0.05);
      this.applyGunVisual(tower.sprite, tower.typeKey, gun, tower.level);
    }

    this.applyTowerFacing(tower);
  }

  // Переключаем текстуры корпуса и пушки по их ТЕКУЩИМ направлениям
  // (корпус и пушка — независимо). Направленные спрайты НЕ вращаем.
  applyTowerFacing(tower) {
    const pos = tower.getPosition();
    const type = tower.config;
    // Спрайт поднят над клеткой визуально (тап-зона — на клетке).
    const baseY = pos.y - BASE_LIFT * this.cellSize;

    // Центр башни (вокруг него облетает пушка) — центр РИСУНКА корпуса.
    let centerX = pos.x;
    let centerY = baseY;
    if (tower.baseSprite) {
      const o = type.baseOrigin || { x: 0.5, y: 1.0 };
      const vis = this.getVisual(tower.baseSprite.texture.key);
      if (vis) {
        centerX = pos.x + (vis.originX - o.x) * tower.baseSprite.displayWidth;
        centerY = baseY + (vis.originY - o.y) * tower.baseSprite.displayHeight;
      }
    }

    if (tower.baseSprite) {
      const base = this.resolveBase(tower.typeKey, tower.baseDir);
      if (base) {
        if (tower.baseSprite.texture.key !== base.key) {
          tower.baseSprite.setTexture(base.key);
          this.applyBaseVisual(tower.baseSprite, tower.typeKey, base);
        }
        tower.baseSprite.setPosition(pos.x, baseY);
        tower.baseSprite.setRotation(base.directional ? 0 : tower.baseAngle);
      }
    }

    if (tower.sprite) {
      const gun = this.resolveGun(tower.typeKey, tower.level, tower.aimDir);
      if (gun) {
        if (tower.sprite.texture.key !== gun.key) {
          tower.sprite.setTexture(gun.key);
          this.applyGunVisual(tower.sprite, tower.typeKey, gun, tower.level);
        }
        if (gun.directional) {
          // Пушка облетает ЦЕНТР башни в сторону цели.
          const orbit = (type.gunOrbit || 0) * this.cellSize;
          const orbitX = orbit * (type.gunOrbitX || 1); // растяжение по горизонтали
          const orbitY = orbit * (type.gunOrbitY || 1); // сжатие по вертикали
          const mount = type.gunMount || { x: 0, y: 0 };
          const p = ellipseArcPoint(tower.aimAngle, orbitX, orbitY); // ровная скорость
          const gunX = centerX + p.x + mount.x * this.cellSize;
          const gunY = centerY + p.y + mount.y * this.cellSize;
          tower.sprite.setPosition(gunX, gunY);
          tower.sprite.setRotation(0);
          // За спиной — когда пушка смотрит наверх (в дальнюю от камеры сторону).
          // Порог по синусу угла: меньше |значение| = раньше уходит за спину.
          const baseDepth = 10 + (tower.gx + tower.gy) * 0.01;
          const behind = Math.sin(tower.aimAngle) < -0.05;
          tower.sprite.setDepth(behind ? baseDepth - 0.05 : baseDepth + 0.05);
        } else {
          tower.sprite.setPosition(pos.x, pos.y);
          tower.sprite.setRotation(tower.aimAngle);
        }
      }
    }
  }

  // Меняем пушку башни (например, после улучшения уровня).
  refreshTowerSprite(tower) {
    const gun = this.resolveGun(tower.typeKey, tower.level, tower.aimDir);

    if (!gun) {
      if (tower.sprite) {
        tower.sprite.destroy();
        tower.sprite = null;
      }
      return;
    }

    if (!tower.sprite) {
      const pos = tower.getPosition();
      const depth = 10 + (tower.gx + tower.gy) * 0.01 + 0.05;
      tower.sprite = this.add.image(pos.x, pos.y, gun.key).setDepth(depth);
      this.applyGunVisual(tower.sprite, tower.typeKey, gun, tower.level);
    }

    this.applyTowerFacing(tower);
  }

  // Ключ корпуса: направленный "<type>_base_<dir>" → старый "<type>_base"
  // → запасная картинка типа. directional=true → не вращать.
  resolveBase(typeKey, dir) {
    const dirKey = `${typeKey}_base_${dir}`;
    if (this.textures.exists(dirKey)) return { key: dirKey, directional: true };

    const legacyKey = `${typeKey}_base`;
    if (this.textures.exists(legacyKey)) return { key: legacyKey, directional: false };

    // Общий шаблон-заглушка (для типов без своей модели).
    const templateKey = `template_base_${dir}`;
    if (this.textures.exists(templateKey)) return { key: templateKey, directional: true };

    const fallback = TOWER_TYPES[typeKey].baseTexture;
    if (this.textures.exists(fallback)) return { key: fallback, directional: false };
    return null;
  }

  // Ключ пушки: "<type>_gun_<level>_<dir>" (не вращается) → старый
  // "<type>_<level>" (вращается, ближайший доступный уровень) → null.
  resolveGun(typeKey, level, dir) {
    const dirKey = `${typeKey}_gun_${level}_${dir}`;
    if (this.textures.exists(dirKey)) return { key: dirKey, directional: true };

    for (let current = level; current >= 1; current--) {
      const key = `${typeKey}_${current}`;
      if (this.textures.exists(key)) return { key: key, directional: false };
    }
    return null;
  }

  // Вписываем корпус: направленный — фиксированная опора (ноги, низ-центр),
  // старый — авто-центр по непрозрачной части (как раньше).
  applyBaseVisual(image, typeKey, base) {
    const type = TOWER_TYPES[typeKey];
    const contentPx = this.cellSize * type.footprint;
    if (base.directional) {
      const o = type.baseOrigin || { x: 0.5, y: 1.0 };
      this.applyDirectionalVisual(image, base.key, contentPx, o.x, o.y, `${typeKey}_base`);
    } else {
      this.applyTowerVisual(image, base.key, type.footprint);
    }
  }

  // Вписываем пушку: направленная — фиксированная опора (точка крепления).
  applyGunVisual(image, typeKey, gun, level = 1) {
    const type = TOWER_TYPES[typeKey];
    const contentPx = this.cellSize * type.footprint * (type.weaponScale || 1);
    if (gun.directional) {
      const o = type.gunOrigin || { x: 0.5, y: 0.5 };
      this.applyDirectionalVisual(image, gun.key, contentPx, o.x, o.y, `${typeKey}_gun_${level}`);
    } else {
      this.applyTowerVisual(image, gun.key, type.footprint, type.weaponScale);
    }
  }

  // Направленный спрайт: точку опоры берём ФИКСИРОВАННУЮ, а РАЗМЕР считаем один
  // раз на весь набор направлений (по первой увиденной картинке) — иначе при
  // смене направления спрайт «прыгает» и меняет размер.
  applyDirectionalVisual(image, key, contentPx, originX, originY, sizeKey) {
    image.setOrigin(originX, originY);
    if (!(sizeKey in this.dirSizeCache)) {
      const visual = this.getVisual(key);
      const frac = visual && visual.fraction > 0 ? visual.fraction : 1;
      this.dirSizeCache[sizeKey] = contentPx / frac;
    }
    const wholePx = this.dirSizeCache[sizeKey];
    image.setDisplaySize(wholePx, wholePx);
  }

  // Вписываем картинку башни в её footprint и ставим точку опоры в центр
  // непрозрачной части — тогда спрайт встаёт ровно, как бы он ни был нарисован.
  applyTowerVisual(image, textureKey, footprint, sizeFactor = 1) {
    const visual = this.getVisual(textureKey);
    const contentPx = this.cellSize * footprint * sizeFactor; // нужный размер рисунка

    if (visual) {
      image.setOrigin(visual.originX, visual.originY);
      const wholePx = contentPx / visual.fraction; // размер всей картинки вместе с полями
      image.setDisplaySize(wholePx, wholePx);
    } else {
      image.setOrigin(0.5, 0.5);
      image.setDisplaySize(contentPx, contentPx);
    }
  }

  // Ленивый замер картинки (с кэшем), чтобы не сканировать её повторно.
  getVisual(textureKey) {
    if (!(textureKey in this.visualCache)) {
      this.visualCache[textureKey] = this.measureTexture(textureKey);
    }
    return this.visualCache[textureKey];
  }

  // Измеряем картинку: какую долю занимает непрозрачная часть и где её центр.
  measureTexture(key) {
    if (!this.textures.exists(key)) return null;

    const source = this.textures.get(key).getSourceImage();
    const width = source.width;
    const height = source.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null;

    const contentWidth = maxX - minX + 1;
    const contentHeight = maxY - minY + 1;

    return {
      // доля картинки, которую занимает рисунок (по большей стороне)
      fraction: Math.max(contentWidth, contentHeight) / width,
      // центр рисунка в долях 0..1 — сюда ставим точку опоры спрайта
      originX: (minX + maxX + 1) / 2 / width,
      originY: (minY + maxY + 1) / 2 / height,
    };
  }

  // Переставляем корпус и пушку всех башен (при изменении размера экрана).
  layoutTowerSprites() {
    for (const tower of this.towers) this.applyTowerFacing(tower);
  }

  // Удаляем картинки башни (при продаже).
  destroyTowerSprite(tower) {
    if (tower.sprite) {
      tower.sprite.destroy();
      tower.sprite = null;
    }
    if (tower.baseSprite) {
      tower.baseSprite.destroy();
      tower.baseSprite = null;
    }
  }

  // Изо-эллипс (круг world -> эллипс 2:1). Радиус в world units.
  fillIsoEllipse(x, y, radiusUnits, color, alpha) {
    const g = this.rangeGraphics;
    const a = ISO_HW * Math.SQRT2 * radiusUnits;
    const b = ISO_HH * Math.SQRT2 * radiusUnits;
    g.fillStyle(color, alpha);
    g.fillEllipse(x, y, a * 2, b * 2);
  }

  strokeIsoEllipse(x, y, radiusUnits, color, alpha, lineWidth) {
    const g = this.rangeGraphics;
    const a = ISO_HW * Math.SQRT2 * radiusUnits;
    const b = ISO_HH * Math.SQRT2 * radiusUnits;
    g.lineStyle(lineWidth, color, alpha);
    g.strokeEllipse(x, y, a * 2, b * 2);
  }

  // Кольцо радиуса атаки + круг занимаемой площади башни (footprint).
  // Грань атаки (белый пунктир) рисуется отдельно и вращается — см. drawDashedRangeRing.
  showRangeRing(x, y, rangeUnits, color, footprintUnits) {
    this.rangeGraphics.clear();
    if (footprintUnits) {
      this.fillIsoEllipse(x, y, footprintUnits, 0xffffff, 0.06);
      this.strokeIsoEllipse(x, y, footprintUnits, 0xffffff, 0.5, 2);
    }
    this.fillIsoEllipse(x, y, rangeUnits, 0xffffff, 0.04);
    this.activeRange = { x: x, y: y, r: rangeUnits };
  }

  // Кольца конкретной башни (радиус атаки + её площадь).
  showRangeRingForTower(tower) {
    const pos = tower.getPosition();
    this.showRangeRing(pos.x, pos.y, tower.range, tower.config.color, tower.config.footprint / 2);
  }

  // Белая пунктирная вращающаяся грань радиуса атаки.
  drawDashedRangeRing() {
    const g = this.rangeDashGraphics;
    if (!g) return;
    g.clear();
    const ar = this.activeRange;
    if (!ar) return;

    const a = ISO_HW * Math.SQRT2 * ar.r;
    const b = ISO_HH * Math.SQRT2 * ar.r;
    g.lineStyle(3, 0xffffff, 0.9);

    const DASHES = 20;
    const DASH_FRAC = 0.55;
    const step = (Math.PI * 2) / DASHES;
    const SEG = 4;
    for (let i = 0; i < DASHES; i++) {
      const start = i * step + this.rangePhase;
      const end = start + step * DASH_FRAC;
      g.beginPath();
      for (let j = 0; j <= SEG; j++) {
        const t = start + (end - start) * (j / SEG);
        const px = ar.x + Math.cos(t) * a;
        const py = ar.y + Math.sin(t) * b;
        if (j === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.strokePath();
    }
  }

  // Убрать кольца.
  clearRangeRing() {
    if (this.rangeGraphics) this.rangeGraphics.clear();
    if (this.rangeDashGraphics) this.rangeDashGraphics.clear();
    this.activeRange = null;
  }

  // ------------------------- Волны -------------------------
  // Множитель HP врагов на волне (растёт плавно, без резких скачков).
  enemyHpScale(wave) {
    return 1 + (wave - 1) * ENEMY_HP_SCALE;
  }

  // Составляем очередь типов врагов для волны.
  buildWaveComposition(wave) {
    const counts =
      wave <= WAVE_TABLE.length ? { ...WAVE_TABLE[wave - 1] } : this.buildEndlessWave(wave);

    // Боссов выпускаем в конце, чтобы остальные успели создать давление.
    const bossCount = counts.boss || 0;
    delete counts.boss;

    // Смешиваем типы «по кругу», чтобы шли вперемешку.
    const entries = Object.entries(counts).map(([type, n]) => [type, n]);
    const queue = [];
    let added = true;
    while (added) {
      added = false;
      for (const entry of entries) {
        if (entry[1] > 0) {
          queue.push(entry[0]);
          entry[1] -= 1;
          added = true;
        }
      }
    }

    for (let i = 0; i < bossCount; i++) queue.push('boss');
    return queue;
  }

  // Волны после 20-й: плавный рост количества и смешивание типов.
  buildEndlessWave(wave) {
    const step = wave - 20;
    const scale = 1 + step * 0.15;
    const counts = {
      normal: Math.round(20 * scale),
      fast: Math.round(12 * scale),
      armored: Math.round(10 * scale),
      tank: Math.round(5 * scale),
      splitter: Math.round(6 * scale),
      shielded: Math.round(8 * scale),
    };
    if (wave % 10 === 0) counts.boss = Math.max(1, Math.floor((wave - 20) / 10) + 1);
    return counts;
  }

  // Запускаем следующую волну (вызывается кликом по кнопке).
  startNextWave() {
    if (this.isGameOver || this.isWaveActive) return;

    this.currentWave += 1;
    this.isWaveActive = true;
    this.playSfx('sfx_wave', 0.5);
    this.startButton.setVisible(false); // кнопка скрыта во время волны

    // Собираем состав волны и берём из него количество врагов.
    this.waveQueue = this.buildWaveComposition(this.currentWave);
    this.enemiesLeftToSpawn = this.waveQueue.length;

    this.updateUI();
    this.showMessage(`Волна ${this.currentWave} началась!`);

    // Порционный спавн: чем дальше волна, тем чаще выходят враги.
    const interval = Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL - (this.currentWave - 1) * 30);
    this.waveSpawnTimer = this.time.addEvent({
      delay: interval,
      callback: this.spawnWaveEnemy,
      callbackScope: this,
      loop: true,
    });
  }

  // Выпускаем одного врага текущей волны.
  spawnWaveEnemy() {
    if (this.isGameOver || this.enemiesLeftToSpawn <= 0) return;

    const typeKey = this.waveQueue.shift() || 'normal';
    const base = ENEMY_TYPES[typeKey];
    const scale = this.enemyHpScale(this.currentWave);

    // Здоровье и щит зависят от типа и номера волны.
    const hp = Math.round(base.hp * scale);
    const shield = base.shield ? Math.round(base.shield * scale) : 0;

    const enemy = new Enemy(this, this.route, typeKey, hp, shield);
    this.enemies.push(enemy);
    this.enemiesLeftToSpawn -= 1;

    // Все враги выпущены — таймер порционного спавна больше не нужен.
    if (this.enemiesLeftToSpawn === 0 && this.waveSpawnTimer) {
      this.waveSpawnTimer.remove(false);
      this.waveSpawnTimer = null;
    }
  }

  // Волна завершена, если все враги выпущены и на поле никого живого нет.
  checkWaveEnd() {
    if (!this.isWaveActive || this.enemiesLeftToSpawn > 0) return;

    const alive = this.enemies.some((enemy) => enemy.active && !enemy.isDead);
    if (alive) return;

    this.endWave();
  }

  // Завершаем волну: начисляем бонус и возвращаем кнопку старта.
  endWave() {
    this.isWaveActive = false;
    this.gold += WAVE_CLEAR_BONUS;
    this.updateUI();
    this.startButton.setVisible(true);
    this.showMessage(`Волна ${this.currentWave} зачищена! +${WAVE_CLEAR_BONUS} золота`);

    // Чит: авто-старт следующей волны.
    if (this.autoWave && !this.isGameOver) {
      this.time.delayedCall(300, () => this.startNextWave());
    }
  }

  // Экран -> world: через камеру и централизованный screenToWorld.
  pointerToGrid(pointer) {
    const worldPx = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const w = screenToWorld(worldPx.x, worldPx.y);
    return { gx: w.x, gy: w.y };
  }

  // Находим башню под точкой (px, py — в world-пикселях, как getWorldPoint).
  // Хит-тест по ГРАНИЦАМ рисунка корпуса — чтобы зона клика совпадала с картинкой,
  // а не с точкой клетки внизу.
  towerAt(px, py) {
    for (const tower of this.towers) {
      // Кликабельна ТОЛЬКО картинка башни (клетка под ней — нет).
      if (tower.baseSprite) {
        const b = tower.baseSprite.getBounds();
        if (Phaser.Geom.Rectangle.Contains(b, px, py)) return tower;
      }
    }
    return null;
  }

  // Можно ли поставить башню типа type в точку:
  // в пределах поля, не на дороге и не пересекаясь с другими башнями.
  isFreeSpot(gx, gy, type, ignoreTower = null) {
    const radius = type.footprint / 2;

    // Границы мира.
    if (gx - radius < 0 || gx + radius > WORLD_SIZE) return false;
    if (gy - radius < 0 || gy + radius > WORLD_SIZE) return false;

    // Дорога: расстояние от центра до полилинии Route (источник истины).
    if (distanceToRoute(gx, gy, this.route) < radius + ROAD_WIDTH / 2) return false;

    return !this.overlapsOtherTower(gx, gy, type, ignoreTower);
  }

  // Пересекается ли башня с уже стоящими (минимум — 90% суммы радиусов).
  overlapsOtherTower(gx, gy, type, ignoreTower) {
    for (const tower of this.towers) {
      if (tower === ignoreTower) continue;
      const minDistance = ((type.footprint + tower.config.footprint) / 2) * 0.9;
      if (Math.hypot(tower.gx - gx, tower.gy - gy) < minDistance) return true;
    }
    return false;
  }

  // Можно ли разместить башню в точке.
  canPlace(gx, gy, type, ignoreTower = null) {
    return this.isFreeSpot(gx, gy, type, ignoreTower);
  }

  // Обработка нажатия: башня — меню, пустое место — режим установки.
  handlePointerDown(pointer) {
    if (this.isGameOver) return;

    // Сбрасываем состояние панорамирования; «вооружим» его ниже, если
    // нажали по пустому месту (на UI-элементах scene-событие не приходит).
    this.panArmed = false;
    this.panActive = false;

    // ПКМ — отменяем установку и закрываем меню.
    if (pointer.rightButtonDown()) {
      this.cancelAll();
      return;
    }

    const { gx, gy } = this.pointerToGrid(pointer);
    const worldPx = this.cameras.main.getWorldPoint(pointer.x, pointer.y);

    // Нажали на башню — открываем её меню (угол окна — в точке нажатия).
    const existing = this.towerAt(worldPx.x, worldPx.y);
    if (existing) {
      this.menuAnchor = { x: pointer.x, y: pointer.y };
      this.openTowerMenu(existing);
      return;
    }

    // Клик/тап по врагу — жёлтый кружок и окошко с HP. По пустому — прячем.
    const enemyHit = this.enemyAt(worldPx.x, worldPx.y);
    if (enemyHit) {
      this.showEnemyInfo(enemyHit);
      return;
    }
    this.hideEnemyInfo();

    // Клик по пустому месту — закрываем меню.
    this.closeTowerMenu();
    if (gx < 0 || gx > WORLD_SIZE || gy < 0 || gy > WORLD_SIZE) return;

    // Пустое место: разрешаем панорамирование одним пальцем/мышью.
    this.panArmed = true;
    this.panStart.x = pointer.x;
    this.panStart.y = pointer.y;

    // Башня не выбрана — ничего не строим.
    if (!this.selectedTowerType) return;

    this.isPlacing = true;
    this.updateGhost(gx, gy);
  }

  // Отменяем установку башни.
  cancelPlacement() {
    this.isPlacing = false;
    if (this.ghost) this.ghost.setVisible(false);
    this.clearRangeRing();
  }

  // Сброс: отмена установки, снятие выбора, закрытие меню.
  cancelAll() {
    this.isPlacing = false;
    this.selectedTowerType = null;
    this.closeTowerMenu();
    this.refreshBuildMenu();
    if (this.ghost) this.ghost.setVisible(false);
    this.clearRangeRing();
  }

  // Пытаемся построить башню выбранного типа в точке.
  tryBuild(gx, gy) {
    if (!this.selectedTowerType) return false;

    const type = TOWER_TYPES[this.selectedTowerType];

    if (!this.canPlace(gx, gy, type)) {
      this.showMessage('Здесь нельзя строить');
      return false;
    }

    if (this.gold < type.cost) {
      console.warn('Недостаточно золота для постройки башни!');
      this.showMessage(`Не хватает золота! Нужно ${type.cost}`);
      return false;
    }

    this.gold -= type.cost;
    const tower = new Tower(this, gx, gy, this.selectedTowerType);
    this.towers.push(tower);
    this.createTowerSprite(tower);
    this.drawTowers(); // перерисовываем индикаторы уровня
    this.updateUI();
    return true;
  }

  // Показываем «призрак» башни под указателем: зелёный — можно, красный — нельзя.
  updateGhost(gx, gy) {
    // Если открыто меню башни — призрак не показываем (кольцо уже от меню).
    if (this.selectedTower) {
      this.ghost.setVisible(false);
      return;
    }

    const type = this.selectedTowerType ? TOWER_TYPES[this.selectedTowerType] : null;
    const inside = gx >= 0 && gx <= WORLD_SIZE && gy >= 0 && gy <= WORLD_SIZE;

    if (!type || !inside || this.isGameOver) {
      this.ghost.setVisible(false);
      this.clearRangeRing();
      return;
    }

    // Корпус (направление по умолчанию — вперёд).
    const base = this.resolveBase(this.selectedTowerType, DIR_FORWARD);
    if (base) {
      this.ghostBase.setTexture(base.key).setVisible(true);
      this.applyBaseVisual(this.ghostBase, this.selectedTowerType, base);
      this.ghostBase.setRotation(0);
      this.ghostBase.setPosition(0, -BASE_LIFT * this.cellSize);
    } else {
      this.ghostBase.setVisible(false);
    }

    // Центр корпуса призрака (вокруг него облетает пушка).
    let cX = 0;
    let cY = 0;
    if (base) {
      const o = type.baseOrigin || { x: 0.5, y: 1.0 };
      const vis = this.getVisual(base.key);
      if (vis) {
        cX = (vis.originX - o.x) * this.ghostBase.displayWidth;
        cY = -BASE_LIFT * this.cellSize + (vis.originY - o.y) * this.ghostBase.displayHeight;
      }
    }

    // Пушка (1-го уровня, направление по умолчанию).
    const gun = this.resolveGun(this.selectedTowerType, 1, DIR_FORWARD);
    if (gun) {
      this.ghostWeapon.setTexture(gun.key).setVisible(true);
      this.applyGunVisual(this.ghostWeapon, this.selectedTowerType, gun, 1);
      this.ghostWeapon.setRotation(0);
      const mount = type.gunMount || { x: 0, y: 0 };
      if (gun.directional) {
        const orbit = (type.gunOrbit || 0) * this.cellSize;
        const orbitX = orbit * (type.gunOrbitX || 1);
        const orbitY = orbit * (type.gunOrbitY || 1);
        const a = dirToAngle(DIR_FORWARD);
        const p = ellipseArcPoint(a, orbitX, orbitY);
        this.ghostWeapon.setPosition(
          cX + p.x + mount.x * this.cellSize,
          cY + p.y + mount.y * this.cellSize
        );
      } else {
        this.ghostWeapon.setPosition(0, 0);
      }
    } else {
      this.ghostWeapon.setVisible(false);
    }

    const pos = worldToScreen(gx, gy);
    this.ghost.setPosition(pos.x, pos.y);

    const canPlace = this.canPlace(gx, gy, type) && this.gold >= type.cost;
    const tint = canPlace ? 0x66ff66 : 0xff5555;
    this.ghostBase.setTint(tint);
    this.ghostWeapon.setTint(tint);
    this.ghost.setVisible(true);

    // Кольца: бледные круги занятости у всех башен + площадь и радиус будущей.
    this.rangeGraphics.clear();
    for (const t of this.towers) {
      const p = t.getPosition();
      this.strokeIsoEllipse(p.x, p.y, t.config.footprint / 2, 0xffffff, 0.25, 2);
    }
    this.fillIsoEllipse(pos.x, pos.y, type.footprint / 2, tint, 0.15);
    this.strokeIsoEllipse(pos.x, pos.y, type.footprint / 2, tint, 0.9, 2);
    // Радиус атаки — белым пунктиром (рисуется и вращается в update).
    this.fillIsoEllipse(pos.x, pos.y, type.range, 0xffffff, 0.04);
    this.activeRange = { x: pos.x, y: pos.y, r: type.range };
  }

  // Движение указателя: показываем призрак будущей башни.
  handlePointerMove(pointer) {
    if (this.isGameOver) return;

    // Одним пальцем/мышью — панорамируем камеру (если потянули по пустому месту).
    if (this.handlePan(pointer)) {
      this.hoverEnemy = null;
      this.hideEnemyInfo();
      return;
    }

    const { gx, gy } = this.pointerToGrid(pointer);

    // ПК: наведение на врага — жёлтый кружок.
    if (!this.isTouch) {
      const worldPx = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.hoverEnemy = this.enemyAt(worldPx.x, worldPx.y);
    }

    // Показываем призрак будущей башни под указателем.
    this.updateGhost(gx, gy);
  }

  // Панорамирование одним пальцем/мышью. true — если камера сдвинулась
  // (тогда не показываем призрак башни и не строим по отпусканию).
  handlePan(pointer) {
    if (!this.panArmed || this.pinchActive) {
      return false;
    }
    if (!pointer.isDown) return false;

    // Ещё не определились: ждём, пока потянут дальше порога.
    if (!this.panActive) {
      const moved = Phaser.Math.Distance.Between(
        pointer.x,
        pointer.y,
        this.panStart.x,
        this.panStart.y
      );
      if (moved < 12 * DPR) return false;

      // Это потяг, а не тап: отменяем установку башни.
      this.panActive = true;
      if (this.isPlacing) {
        this.isPlacing = false;
        if (this.ghost) this.ghost.setVisible(false);
      }
      this.clearRangeRing();
      this.panLast.x = pointer.x;
      this.panLast.y = pointer.y;
      return true;
    }

    const cam = this.cameras.main;
    cam.scrollX -= (pointer.x - this.panLast.x) / cam.zoom;
    cam.scrollY -= (pointer.y - this.panLast.y) / cam.zoom;
    this.panLast.x = pointer.x;
    this.panLast.y = pointer.y;
    return true;
  }

  // Отпускание: завершаем панорамирование или ставим новую башню.
  handlePointerUp(pointer) {
    // Сбрасываем панорамирование. Если панорамировали — тап не выполняем.
    const wasPanning = this.panActive;
    this.panArmed = false;
    this.panActive = false;

    // Если был потяг (панорамирование) — это не тап, ничего не строим.
    if (wasPanning) return;

    // Установка новой башни: строим там, где отпустили палец/мышь.
    if (this.isPlacing) {
      this.isPlacing = false;
      const { gx, gy } = this.pointerToGrid(pointer);
      const built = this.tryBuild(gx, gy);
      this.ghost.setVisible(false);
      this.clearRangeRing();

      // Без Shift после постройки выбор снимается.
      // С зажатым Shift можно ставить башни подряд.
      const keepPlacing = this.shiftKey && this.shiftKey.isDown;
      if (built && !keepPlacing) this.clearTowerSelection();
    }
  }

  // Игровой цикл: двигаем врагов, работаем башнями, летим снарядами.
  update(time, delta) {
    updateRoundBgs(this); // держим фон кнопок в синхроне с видимостью/размером
    if (this.isGameOver) return; // игра остановлена

    const rawDelta = delta; // реальное время — для анимаций, не зависящих от ускорения
    delta *= this.timeScale; // ускорение времени (стафф)

    // Враги (движение — в world-координатах по Route).
    for (const enemy of this.enemies) {
      if (!enemy.isDead) {
        enemy.moveAlongPath(delta);
      }
    }

    // Башни: перезарядка, поиск цели, выстрел и наводка корпуса/пушки.
    for (const tower of this.towers) {
      tower.update(delta, this.enemies);
      this.applyTowerFacing(tower);
    }

    // Снаряды.
    for (const projectile of this.projectiles) {
      projectile.flyToTarget(delta);
    }

    // Чистим удалённые объекты.
    this.enemies = this.enemies.filter((enemy) => enemy.active);
    this.projectiles = this.projectiles.filter((projectile) => projectile.active);

    // Окошко с HP врага (кружок по клику/наведению, плашка по клику).
    this.updateEnemyInfo();

    // Вращаем пунктирное кольцо радиуса атаки (скорость не зависит от ускорения).
    this.rangePhase += (rawDelta / 1000) * 1.2;
    this.drawDashedRangeRing();

    // Проверяем, не закончилась ли волна.
    this.checkWaveEnd();
  }
}

// --------------------------- Конфигурация Phaser ---------------------------
const config = {
  type: Phaser.AUTO, // WebGL, а при его отсутствии — Canvas
  parent: 'game',
  backgroundColor: BG_COLOR,
  render: {
    antialias: true,
    // Мипмапы убирают «мыло» при уменьшении спрайтов (важно на телефоне).
    mipmapFilter: 'LINEAR_MIPMAP_LINEAR',
  },
  scale: {
    // NONE: размер задаём сами (в физических пикселях) под плотность экрана.
    // Иначе Phaser рисует в CSS-разрешении, и телефон растягивает картинку.
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth * DPR,
    height: window.innerHeight * DPR,
    zoom: 1 / DPR, // стиль канваса = CSS-пиксели (бэкенд-буфер в DPR раз больше)
  },
  scene: [MenuScene, GameScene],
};

// Запускаем игру.
const game = new Phaser.Game(config);

// Держим канвас в физическом разрешении экрана и пересобираем при ресайзе.
function applyCanvasSize() {
  if (!game.scale || !game.scale.canvas) return;
  game.scale.resize(window.innerWidth * DPR, window.innerHeight * DPR);
}
window.addEventListener('resize', applyCanvasSize);
window.addEventListener('orientationchange', () => setTimeout(applyCanvasSize, 200));
game.events.once('ready', applyCanvasSize);
applyCanvasSize();
