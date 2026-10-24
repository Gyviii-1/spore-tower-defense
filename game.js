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

// Флаг сборки / ветки:
// В ветке beta = true (тестовая ветка с чит-меню).
// В ветке main = false (релизная продакшн-ветка, чит-меню полностью отключено).
const IS_BETA_BUILD = true;

// Максимальное количество башен, которое игрок может взять в бой (колода башен)
const MAX_DECK_SLOTS = 5;

// Получить выбранный боевой набор башен (не более 5)
function getPlayerDeck() {
  try {
    const raw = localStorage.getItem('spore_td_deck');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid = parsed.filter((key) => Boolean(TOWER_TYPES[key]));
        if (valid.length > 0) {
          return valid.slice(0, MAX_DECK_SLOTS);
        }
      }
    }
  } catch (e) {}
  // По умолчанию — первые до 5 доступных типов башен
  const def = Object.keys(TOWER_TYPES).slice(0, MAX_DECK_SLOTS);
  savePlayerDeck(def);
  return def;
}

// Сохранить выбранный боевой набор башен
function savePlayerDeck(deck) {
  try {
    const trimmed = Array.isArray(deck) ? deck.slice(0, MAX_DECK_SLOTS) : [];
    localStorage.setItem('spore_td_deck', JSON.stringify(trimmed));
  } catch (e) {}
}

// HiDPI-масштаб: рендерим канвас в физическом разрешении экрана, а UI
// задаём в «CSS-пикселях», умножая абсолютные размеры на DPR.
const DPR = Math.min(window.devicePixelRatio || 1, 2);

// Коэффициент рендера шрифтов для абсолютной чёткости текста (High-DPI / Retina):
// Phaser по умолчанию рендерит текст в 1x, из-за чего на мобильных и масштабируемых контейнерах
// возникает мыло. Задаём гарантированный рендер в высоком разрешении.
const TEXT_RESOLUTION = Math.max(DPR * 2, 2.5);

if (typeof Phaser !== 'undefined' && Phaser.GameObjects) {
  if (Phaser.GameObjects.GameObjectFactory && Phaser.GameObjects.GameObjectFactory.prototype.text) {
    const _origFactoryText = Phaser.GameObjects.GameObjectFactory.prototype.text;
    Phaser.GameObjects.GameObjectFactory.prototype.text = function (x, y, text, style) {
      const mergedStyle = Object.assign({ resolution: TEXT_RESOLUTION }, style);
      return _origFactoryText.call(this, x, y, text, mergedStyle);
    };
  }
  if (Phaser.GameObjects.TextStyle && Phaser.GameObjects.TextStyle.prototype.setStyle) {
    const _origTextStyleSetStyle = Phaser.GameObjects.TextStyle.prototype.setStyle;
    Phaser.GameObjects.TextStyle.prototype.setStyle = function (style, updateText, setDefaults) {
      if (style && style.resolution === undefined) {
        style.resolution = TEXT_RESOLUTION;
      }
      return _origTextStyleSetStyle.call(this, style, updateText, setDefaults);
    };
  }
}

const GRID_SIZE = 10;             // размер сетки: 10 на 10 клеток
const BG_COLOR = 0x000000;        // цвет фона сцены (тёмный графит лаборатории)
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
    cost: 40,
    range: 3.0,
    fireRate: 2.2,
    damage: 24,
    accuracy: 0.90, // Точность попадания 90% (баланс TDS Scout)
    bulletSpeed: 14,
    footprint: 0.7, // размер корпуса в клетках
    weaponScale: 0.5, // во сколько раз пушка меньше корпуса
    baseTexture: 'tower', // корпус (стоит на месте)
    texture: 'tower', // запасная картинка
    color: 0xe63946,
    baseOrigin: { x: 0.5, y: 0.5 }, // опора корпуса — центр картинки
    gunOrigin: { x: 0.5, y: 0.5 },  // опора пушки — точка крепления в картинке
    gunOrbit: 0.30,                 // радиус облёта пушки вокруг корпуса (в долях клетки)
    gunOrbitX: 1.15,                // растяжение орбиты по горизонтали (по бокам чуть дальше)
    gunOrbitY: 0.5,                 // сжатие орбиты по вертикали
    gunMount: { x: 0, y: 0.1 },     // доп. сдвиг пушки (в долях клетки) — ниже
    levels: [
      { name: 'ПМ', damage: 24, fireRate: 2.2, range: 3.0, accuracy: 0.90, bulletSpeed: 14, upgradeCost: 0 },
      { name: 'Глок', damage: 32, fireRate: 2.8, range: 3.2, accuracy: 0.92, bulletSpeed: 15, upgradeCost: 55 },
      { name: 'Тек-9', damage: 26, fireRate: 5.0, range: 3.2, accuracy: 0.90, bulletSpeed: 14, upgradeCost: 110 },
      { name: 'Дигл', damage: 155, fireRate: 1.3, range: 3.8, accuracy: 0.95, bulletSpeed: 18, upgradeCost: 230 },
      { name: 'P90', damage: 42, fireRate: 8.0, range: 3.6, accuracy: 0.92, bulletSpeed: 17, upgradeCost: 420 },
    ],
  },
  minigun: {
    name: 'Пулемётчик',
    cost: 85,
    range: 3.4,
    fireRate: 6.5,
    damage: 18,
    accuracy: 0.80, // Точность шквального огня 80% (TDS Minigunner)
    bulletSpeed: 15,
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
    levels: [
      { name: 'АК-47', damage: 18, fireRate: 6.5, range: 3.4, accuracy: 0.80, bulletSpeed: 15, upgradeCost: 0 },
      { name: 'РПК', damage: 25, fireRate: 8.0, range: 3.7, accuracy: 0.82, bulletSpeed: 16, upgradeCost: 130 },
      { name: 'ПКМ', damage: 34, fireRate: 9.5, range: 4.0, accuracy: 0.85, bulletSpeed: 17, upgradeCost: 260 },
      { name: 'Миниган M134', damage: 22, fireRate: 22.0, range: 4.2, accuracy: 0.88, bulletSpeed: 18, upgradeCost: 480 },
      { name: 'Спаренный миниган', damage: 18, fireRate: 20.0, dualBarrels: true, range: 4.4, accuracy: 0.90, bulletSpeed: 18, upgradeCost: 780 },
    ],
  },
  sniper: {
    name: 'Снайпер',
    cost: 105,
    range: 5.2,
    fireRate: 0.75,
    damage: 85,
    accuracy: 1.00, // Высокоточный огонь 100% (TDS Sniper)
    onlyElevation: true, // ставится ТОЛЬКО на возвышенности
    bulletSpeed: 25,
    footprint: 0.75,
    weaponScale: 0.65,
    baseTexture: 'tower',
    texture: 'tower',
    color: 0xf39c12,
    baseOrigin: { x: 0.5, y: 0.5 },
    gunOrigin: { x: 0.5, y: 0.5 },
    gunOrbit: 0.32,
    gunOrbitX: 1.15,
    gunOrbitY: 0.5,
    gunMount: { x: 0, y: 0.1 },
    levels: [
      { name: 'СКС', damage: 85, fireRate: 0.75, range: 5.2, accuracy: 1.00, bulletSpeed: 24, upgradeCost: 0 },
      { name: 'СВД', damage: 145, fireRate: 0.80, range: 5.5, accuracy: 1.00, bulletSpeed: 27, upgradeCost: 140 },
      { name: 'ВСС Винторез', damage: 215, fireRate: 1.05, range: 5.3, accuracy: 1.00, bulletSpeed: 26, upgradeCost: 290 },
      { name: 'Barrett M82', damage: 480, fireRate: 0.65, range: 6.2, accuracy: 1.00, bulletSpeed: 30, upgradeCost: 520 },
      { name: 'Рельсотрон "Гарпун"', damage: 1000, fireRate: 0.55, range: 7.0, accuracy: 1.00, bulletSpeed: 38, upgradeCost: 900 },
    ],
  },
  disinfector: {
    name: 'Дезинфектор',
    cost: 95,
    range: 3.0,
    fireRate: 1.5,
    damage: 16,
    accuracy: 1.00, // Аэрозольное поле 100%
    cureChance: 0.10,
    splashRadius: 1.3,
    sprayCone: (42 * Math.PI) / 180,
    footprint: 0.75,
    weaponScale: 0.6,
    baseTexture: 'tower',
    texture: 'tower',
    color: 0x2ecc71,
    baseOrigin: { x: 0.5, y: 0.5 },
    gunOrigin: { x: 0.5, y: 0.5 },
    gunOrbit: 0.28,
    gunOrbitX: 1.15,
    gunOrbitY: 0.5,
    gunMount: { x: 0, y: 0.1 },
    levels: [
      { name: 'Аэрозоль', damage: 16, splashRadius: 1.3, cureChance: 0.10, accuracy: 1.00, fireRate: 1.5, range: 3.0, upgradeCost: 0 },
      { name: 'Опрыскиватель', damage: 25, splashRadius: 1.4, cureChance: 0.14, accuracy: 1.00, fireRate: 2.4, range: 3.2, upgradeCost: 90 },
      { name: 'Газомёт', damage: 38, splashRadius: 1.6, cureChance: 0.18, accuracy: 1.00, fireRate: 3.8, range: 3.5, upgradeCost: 180 },
      { name: 'Химраспылитель', damage: 58, splashRadius: 1.7, cureChance: 0.24, accuracy: 1.00, fireRate: 6.2, range: 3.8, upgradeCost: 350 },
      { name: 'Био-очиститель', damage: 500, splashRadius: 2.0, cureChance: 0.32, accuracy: 1.00, continuous: true, fireRate: 0, range: 4.2, upgradeCost: 620 },
    ],
  },
  tesla: {
    name: 'Тесла',
    cost: 120,
    range: 3.0,
    fireRate: 1.15,
    damage: 34,
    accuracy: 1.00, // Электрическая дуга 100%
    chainCount: 2,
    chainRange: 2.5,
    footprint: 0.8,
    weaponScale: 0.65,
    baseTexture: 'tower',
    texture: 'tower',
    color: 0x00d2ff,
    baseOrigin: { x: 0.5, y: 0.5 },
    gunOrigin: { x: 0.5, y: 0.5 },
    gunOrbit: 0.30,
    gunOrbitX: 1.15,
    gunOrbitY: 0.5,
    gunMount: { x: 0, y: 0.1 },
    levels: [
      { name: 'Разрядник', damage: 34, chainCount: 2, accuracy: 1.00, fireRate: 1.15, range: 3.0, upgradeCost: 0 },
      { name: 'Трансформатор', damage: 50, chainCount: 2, accuracy: 1.00, fireRate: 1.25, range: 3.2, upgradeCost: 120 },
      { name: 'Катушка Тесла', damage: 72, chainCount: 3, accuracy: 1.00, fireRate: 1.35, range: 3.5, upgradeCost: 250 },
      { name: 'Плазмотрон', damage: 105, chainCount: 3, accuracy: 1.00, fireRate: 1.50, range: 3.8, upgradeCost: 450 },
      { name: 'Громовержец', damage: 160, chainCount: 4, accuracy: 1.00, fireRate: 1.75, range: 4.2, upgradeCost: 720 },
    ],
  },
};

// Дополнительные данные турелей для Инвентаря (роли и особенности)
const TOWER_EXTRA_INFO = {
  gunner: {
    role: 'Стрелковый пост · Одиночный и полуавтоматический огонь',
    traitDesc: 'Армейские пистолеты и PDW. Высокая точность (90%–95%). На 4 ур. — крупнокалиберный Desert Eagle (.50 AE), на 5 ур. — FN P90 (8 выстр/с).',
  },
  minigun: {
    role: 'Тяжёлый пулемётчик · Заградительный шквал огня',
    traitDesc: 'Автоматы и пулемёты до 25 выстр/с. Плотный огонь (точность 80%–90%). На 4 ур. — M134, на 5 ур. — спаренная турель.',
  },
  sniper: {
    role: 'Высокоточный пост · Ставится ТОЛЬКО на возвышенностях',
    traitDesc: 'Экстремальная дальность и 100% точность. Требует высотной позиции на карте! На 4 ур. — Barrett .50 BMG, на 5 ур. — рельсотрон.',
  },
  disinfector: {
    role: 'Санитарный комплекс · Аэрозольная дезинфекция',
    traitDesc: 'Распыляет химикаты в секторе со 100% точностью, нанося урон сквозь броню. Способен излечивать заражённых. На 5 ур. генерирует сплошной поток.',
  },
  tesla: {
    role: 'Энергетический генератор · Цепной разряд',
    traitDesc: 'Бьёт электрической дугой со 100% точностью, перескакивающей между целями (до 4 мутантов). Мгновенное поражение.',
  },
};

const ENEMY_HIT_COLOR = 0xffffff; // вспышка врага при попадании
const ENEMY_HP = 65;              // базовое здоровье врага по умолчанию
const ENEMY_HP_SCALE = 0.12;      // прирост HP врагов за волну (множитель)

// Типы врагов. hp — базовое здоровье, speed — клеток/сек, color — цвет,
// reward — золото за убийство, size — размер от клетки.
// damageMultiplier — множитель получаемого урона (броня).
// shield / shieldColor — отдельный запас щита (щитоносец).
// splitInto / splitCount — на кого распадается при смерти.
// livesDamage — сколько жизней снимает, если дойдёт до конца.
const ENEMY_TYPES = {
  normal: { hp: 70, speed: 1.7, color: 0xe74c3c, reward: 12, size: 0.60 },
  fast: { hp: 48, speed: 3.4, color: 0xf39c12, reward: 10, size: 0.45 },
  armored: {
    hp: 195,
    speed: 1.25,
    color: 0x7f8c8d,
    reward: 26,
    size: 0.62,
    damageMultiplier: 0.65,
  },
  stalker: {
    hp: 150,
    speed: 2.6,
    color: 0x9b59b6,
    reward: 28,
    size: 0.50,
    damageMultiplier: 0.85,
  },
  regenerator: {
    hp: 380,
    speed: 1.15,
    color: 0x16a085,
    reward: 42,
    size: 0.68,
    regen: 24,
  },
  tank: { hp: 700, speed: 0.75, color: 0x8e44ad, reward: 75, size: 0.80 },
  splitter: {
    hp: 300,
    speed: 1.45,
    color: 0x27ae60,
    reward: 34,
    size: 0.70,
    splitInto: 'small',
    splitCount: 2,
  },
  small: { hp: 50, speed: 2.7, color: 0xe63946, reward: 6, size: 0.34 },
  shielded: {
    hp: 340,
    speed: 1.25,
    color: 0x2980b9,
    reward: 52,
    size: 0.70,
    shield: 260,
    shieldColor: 0x66ccff,
  },
  boss: { hp: 4800, speed: 0.65, color: 0x2c3e50, reward: 550, size: 1.15, livesDamage: 5 },
};

// Множитель шанса исцеления врага дезинфектором.
// Босс — полный иммунитет (0). Танк — мизерный шанс (споры глубоко вросли).
function getEnemyCureMultiplier(enemy) {
  if (!enemy || !enemy.typeKey) return 1.0;
  switch (enemy.typeKey) {
    case 'boss':
      return 0; // Полный иммунитет
    case 'tank':
      return 0.05; // Мизерный шанс (~0.3% на ур. 1, ~1.25% на ур. 5)
    case 'shielded':
      return enemy.shield > 0 ? 0.15 : 0.4; // Щит сдерживает газ
    case 'armored':
      return 0.35; // Панцирь защищает от газа
    case 'regenerator':
      return 0.25; // Быстрая клеточная мутация сдерживает сыворотку
    case 'splitter':
      return 0.6;
    case 'stalker':
      return 0.95; // Быстрый метаболизм
    case 'normal':
      return 1.0;
    case 'fast':
      return 1.2;
    case 'small':
      return 1.4; // Мелкие споры очищаются легче всего
    default:
      return 1.0;
  }
}

// Множитель урона газа дезинфектора.
// Газ бьёт сквозь броню, но чем сильнее враг захвачен/оброс спорами,
// тем выше у него био-сопротивление и тем меньше урона он получает.
function getEnemyGasDamageMultiplier(enemy) {
  if (!enemy || !enemy.typeKey) return 1.0;
  switch (enemy.typeKey) {
    case 'boss':
      return 0.20; // Одно целое со спорами — колоссальное био-сопротивление
    case 'tank':
      return 0.35; // Полностью оброс спорами — плотная биомасса
    case 'shielded':
      return 0.50; // Споровый щит сдерживает газ
    case 'regenerator':
      return 0.55; // Плотная регенерирующая ткань
    case 'armored':
      return 0.60; // Плотная споровая корка (при этом металлическая броня пробивается)
    case 'splitter':
      return 0.75; // Глубокая споровая мутация
    case 'stalker':
      return 1.0;  // Подвижный охотник — стандартный урон
    case 'normal':
      return 1.0;  // Базовая спора — стандартный урон
    case 'fast':
      return 1.20; // Тонкая оболочка — уязвима к газу
    case 'small':
      return 1.35; // Молодые споры выжигаются быстрее всего
    default:
      return 1.0;
  }
}

// ----------------------------- Волны -----------------------------
const SPAWN_GAP_TILES_BASE = 3.2;  // базовая дистанция между врагами в клетках на 1-й волне
const SPAWN_GAP_TILES_MIN = 2.2;   // минимальная дистанция между врагами на поздних волнах
const SPAWN_INTERVAL = 1000;      // обратная совместимость (мс)
const SPAWN_INTERVAL_MIN = 300;   // обратная совместимость (мс)
const WAVE_CLEAR_BONUS = 40;      // бонус золота за зачистку волны

// Состав волн 1–30.
// Лёгкий: 20 волн, Средний: 25 волн, Трудный: 30 волн. Дальше — процедурно (buildEndlessWave).
const WAVE_TABLE = [
  { normal: 10 }, // 1
  { normal: 15 }, // 2
  { normal: 20 }, // 3
  { normal: 15, fast: 6 }, // 4
  { normal: 20, fast: 8 }, // 5
  { normal: 16, fast: 12 }, // 6
  { normal: 20, armored: 5 }, // 7
  { normal: 16, fast: 10, armored: 8 }, // 8
  { normal: 22, stalker: 6 }, // 9
  { normal: 20, armored: 6, tank: 3 }, // 10
  { normal: 18, fast: 12, stalker: 8, tank: 4 }, // 11
  { normal: 22, armored: 10, regenerator: 4 }, // 12
  { normal: 20, splitter: 6 }, // 13
  { fast: 16, splitter: 8, armored: 6 }, // 14
  { normal: 22, fast: 10, stalker: 8, tank: 4 }, // 15
  { normal: 20, shielded: 8, armored: 6 }, // 16
  { fast: 16, shielded: 10, regenerator: 6 }, // 17
  { normal: 20, armored: 10, shielded: 8, splitter: 6 }, // 18
  { fast: 12, armored: 8, stalker: 10, regenerator: 6, tank: 4 }, // 19
  { boss: 1, normal: 20, fast: 12, armored: 6 }, // 20 (Финал Лёгкого режима)
  { normal: 24, armored: 12, stalker: 12, regenerator: 8 }, // 21
  { fast: 20, shielded: 12, tank: 6, splitter: 8 }, // 22
  { armored: 16, regenerator: 10, stalker: 14, tank: 6 }, // 23
  { normal: 26, shielded: 14, regenerator: 12, splitter: 10 }, // 24
  { boss: 1, tank: 8, armored: 14, regenerator: 10, stalker: 16 }, // 25 (Финал Среднего режима)
  { normal: 30, armored: 18, stalker: 18, tank: 8 }, // 26
  { fast: 24, shielded: 18, regenerator: 14, splitter: 12 }, // 27
  { armored: 20, stalker: 20, regenerator: 16, tank: 10 }, // 28
  { shielded: 20, tank: 12, regenerator: 18, splitter: 14 }, // 29
  { boss: 2, tank: 12, regenerator: 20, stalker: 24, armored: 18 }, // 30 (Финал Трудного режима)
];

// Режимы сложности игры
const GAME_DIFFICULTIES = {
  easy: {
    id: 'easy',
    name: 'Лёгкий',
    badge: 'ЛЕГКИЙ',
    color: '#2ecc71',
    colorHex: 0x2ecc71,
    startGold: 200,
    baseHp: 1500,
    hpMultiplier: 0.85,
    speedMultiplier: 0.90,
    rewardMultiplier: 1.15,
    totalWaves: 20,
    passXpPerWave: 25,
    desc: 'Замедленные мутанты, сниженное здоровье, больше золота (20 волн).'
  },
  medium: {
    id: 'medium',
    name: 'Средний',
    badge: 'СРЕДНИЙ',
    color: '#3498db',
    colorHex: 0x3498db,
    startGold: 140,
    baseHp: 1000,
    hpMultiplier: 1.0,
    speedMultiplier: 1.0,
    rewardMultiplier: 1.0,
    totalWaves: 25,
    passXpPerWave: 40,
    desc: 'Стандартный протокол лаборатории. Сбалансированный натиск (25 волн).'
  },
  hard: {
    id: 'hard',
    name: 'Трудный',
    badge: 'ТРУДНЫЙ',
    color: '#e74c3c',
    colorHex: 0xe74c3c,
    startGold: 100,
    baseHp: 650,
    hpMultiplier: 1.25,
    speedMultiplier: 1.12,
    rewardMultiplier: 0.90,
    totalWaves: 30,
    passXpPerWave: 60,
    desc: 'Критический прорыв био-угрозы. Быстрые мутанты, дефицит бюджета (30 волн).'
  }
};

// Доступные карты игры с путями, возвышенностями и атмосферой
const GAME_MAPS = {
  lab: {
    id: 'lab',
    name: 'Сектор Омега: Лаборатория',
    shortName: 'Лаборатория',
    badge: 'ЛАБОРАТОРИЯ',
    desc: 'Герметичные шлюзы и центральный лабораторный коридор.',
    theme: {
      cellColor: 0x161a24,
      roadColor: 0x475569,
      gridColor: 0x263044,
      accentColor: 0x38bdf8,
      elevationTop: 0x2b3954,
      elevationSide: 0x182234,
      elevationBorder: 0x4ea8de,
    },
    waypoints: [
      { x: 0.5, y: 0.5 },
      { x: 6.5, y: 0.5 },
      { x: 6.5, y: 3.5 },
      { x: 1.5, y: 3.5 },
      { x: 1.5, y: 6.5 },
      { x: 8.5, y: 6.5 },
      { x: 8.5, y: 9.5 },
      { x: 9.5, y: 9.5 },
    ],
    // Возвышенные платформы (для снайперов и лучшего обзора)
    elevations: [
      { x: 3, y: 1, w: 2, h: 2, label: 'Платформа А' },
      { x: 4, y: 4, w: 2, h: 2, label: 'Платформа Б' },
      { x: 3, y: 7, w: 2, h: 2, label: 'Платформа В' },
    ],
  },
  reactor: {
    id: 'reactor',
    name: 'Энергоблок: Био-Реактор',
    shortName: 'Био-Реактор',
    badge: 'РЕАКТОР',
    desc: 'Обходные мостки вокруг реактора с охладительным контуром.',
    theme: {
      cellColor: 0x1c172a,
      roadColor: 0x5b4778,
      gridColor: 0x2d2244,
      accentColor: 0xa855f7,
      elevationTop: 0x3b2a59,
      elevationSide: 0x221736,
      elevationBorder: 0xc084fc,
    },
    waypoints: [
      { x: 0.5, y: 1.5 },
      { x: 1.5, y: 1.5 },
      { x: 1.5, y: 8.5 },
      { x: 5.5, y: 8.5 },
      { x: 5.5, y: 2.5 },
      { x: 8.5, y: 2.5 },
      { x: 8.5, y: 9.5 },
      { x: 9.5, y: 9.5 },
    ],
    elevations: [
      { x: 3, y: 3, w: 2, h: 3, label: 'Охладитель' },
      { x: 6, y: 5, w: 2, h: 3, label: 'Генератор' },
    ],
  },
  catacombs: {
    id: 'catacombs',
    name: 'Дренажный Сектор: Катакомбы',
    shortName: 'Катакомбы',
    badge: 'КАТАКОМБЫ',
    desc: 'Подземные коллекторы под комплексом. Гнездовье спор.',
    theme: {
      cellColor: 0x12221b,
      roadColor: 0x365345,
      gridColor: 0x1f382c,
      accentColor: 0x22c55e,
      elevationTop: 0x1f3d30,
      elevationSide: 0x13271f,
      elevationBorder: 0x4ade80,
    },
    waypoints: [
      { x: 0.5, y: 2.5 },
      { x: 7.5, y: 2.5 },
      { x: 7.5, y: 5.5 },
      { x: 1.5, y: 5.5 },
      { x: 1.5, y: 8.5 },
      { x: 8.5, y: 8.5 },
      { x: 8.5, y: 9.5 },
      { x: 9.5, y: 9.5 },
    ],
    elevations: [
      { x: 3, y: 0, w: 3, h: 2, label: 'Уступ Вверху' },
      { x: 4, y: 6, w: 3, h: 2, label: 'Уступ Внизу' },
    ],
  },
};

// ---------------------- Боевой Пасс (Прогрессия & Награды) ----------------------
const BATTLE_PASS_TIERS = [
  { level: 1, xpReq: 0, free: '150 🟡 Золота', prem: '300 🟡 Золота' },
  { level: 2, xpReq: 250, free: '250 🟡 Золота', prem: '+50 🛡️ Броня базы' },
  { level: 3, xpReq: 600, free: '+10% Опыт волн', prem: '+20% Опыт волн' },
  { level: 4, xpReq: 1100, free: '350 🟡 Золота', prem: 'Ускорение перезарядки -5%' },
  { level: 5, xpReq: 1800, free: 'Эмблема Ветерана', prem: '500 🟡 Золота' },
  { level: 6, xpReq: 2700, free: '500 🟡 Золота', prem: '+100 🛡️ Броня базы' },
  { level: 7, xpReq: 3800, free: '+15% Золото за мутантов', prem: '+25% Золото за мутантов' },
  { level: 8, xpReq: 5100, free: '750 🟡 Золота', prem: 'Боезапас +20%' },
  { level: 9, xpReq: 6600, free: 'Модуль «Призрак»', prem: '1000 🟡 Золота' },
  { level: 10, xpReq: 8500, free: 'Титул «Защитник Сектора»', prem: '1500 🟡 Золота + Медаль' },
];

function getPlayerPassXp() {
  try {
    const val = parseInt(localStorage.getItem('spore_td_pass_xp') || '0', 10);
    return isNaN(val) || val < 0 ? 0 : val;
  } catch (e) {
    return 0;
  }
}

function savePlayerPassXp(xp) {
  try {
    localStorage.setItem('spore_td_pass_xp', String(Math.max(0, Math.floor(xp))));
  } catch (e) {}
}

function getPassProgress(totalXp) {
  let currentLevel = 1;
  for (let i = 0; i < BATTLE_PASS_TIERS.length; i++) {
    if (totalXp >= BATTLE_PASS_TIERS[i].xpReq) {
      currentLevel = BATTLE_PASS_TIERS[i].level;
    } else {
      break;
    }
  }

  const currentTier = BATTLE_PASS_TIERS[currentLevel - 1];
  const nextTier = BATTLE_PASS_TIERS[currentLevel] || null;

  let currentTierXp = 0;
  let nextTierNeeded = 0;
  let percent = 1;

  if (nextTier) {
    currentTierXp = totalXp - currentTier.xpReq;
    nextTierNeeded = nextTier.xpReq - currentTier.xpReq;
    percent = Math.min(1, Math.max(0, currentTierXp / nextTierNeeded));
  } else {
    currentTierXp = totalXp - currentTier.xpReq;
    nextTierNeeded = currentTier.xpReq;
    percent = 1;
  }

  return {
    totalXp: totalXp,
    level: currentLevel,
    currentTierXp: currentTierXp,
    nextTierNeeded: nextTierNeeded,
    percent: percent,
    isMax: !nextTier,
  };
}

// ---------------------- Система Квестов & Заданий ----------------------
// Автоматическая генерация и пул постоянных тактических заданий со справедливыми наградами
const QUEST_POOL = [
  { id: 'kill_spores', title: 'Зачистка Сектора', desc: 'Уничтожьте 60 мутантов любого типа', type: 'kills', target: 60, reward: 250, icon: '☣️' },
  { id: 'kill_armored', title: 'Бронебойщик', desc: 'Ликвидируйте 15 бронированных мутантов', type: 'kill_type', enemyType: 'armored', target: 15, reward: 320, icon: '🛡️' },
  { id: 'kill_stalkers', title: 'Охота на Тени', desc: 'Уничтожьте 12 быстрых сталкеров', type: 'kill_type', enemyType: 'stalker', target: 12, reward: 350, icon: '👁️' },
  { id: 'kill_bosses', title: 'Угроза Альфа', desc: 'Уничтожьте 2 боссов био-угрозы', type: 'kill_type', enemyType: 'boss', target: 2, reward: 600, icon: '👑' },
  { id: 'build_towers', title: 'Инженер Обороны', desc: 'Постройте 8 оборонительных турелей', type: 'build', target: 8, reward: 220, icon: '🏗️' },
  { id: 'build_sniper', title: 'Снайперская Точка', desc: 'Разместите 3 снайпера на возвышенностях', type: 'build_type', towerType: 'sniper', target: 3, reward: 300, icon: '🎯' },
  { id: 'survive_waves', title: 'Неотступность', desc: 'Успешно отразите 15 боевых волн', type: 'waves', target: 15, reward: 400, icon: '⚔️' },
  { id: 'reach_wave_20', title: 'Ветеран Сектора', desc: 'Достигните 20-й волны в любом режиме', type: 'reach_wave', target: 20, reward: 550, icon: '🎖️' },
  { id: 'win_game', title: 'Полная Победа', desc: 'Завершите бой победой над всеми волнами', type: 'victory', target: 1, reward: 750, icon: '🏆' },
];

function getPlayerQuests() {
  try {
    const raw = localStorage.getItem('spore_td_quests');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {}

  // Начальная генерация квестов (3 активных задачи)
  const initial = [
    { ...QUEST_POOL[0], progress: 0, claimed: false },
    { ...QUEST_POOL[4], progress: 0, claimed: false },
    { ...QUEST_POOL[6], progress: 0, claimed: false },
  ];
  savePlayerQuests(initial);
  return initial;
}

function savePlayerQuests(quests) {
  try {
    localStorage.setItem('spore_td_quests', JSON.stringify(quests));
  } catch (e) {}
}

function updateQuestProgress(actionType, param = null, amount = 1) {
  const quests = getPlayerQuests();
  let changed = false;

  for (const q of quests) {
    if (q.claimed) continue;
    let match = false;
    if (q.type === 'kills' && actionType === 'kill') match = true;
    else if (q.type === 'kill_type' && actionType === 'kill' && q.enemyType === param) match = true;
    else if (q.type === 'build' && actionType === 'build') match = true;
    else if (q.type === 'build_type' && actionType === 'build' && q.towerType === param) match = true;
    else if (q.type === 'waves' && actionType === 'wave_clear') match = true;
    else if (q.type === 'reach_wave' && actionType === 'wave_start') {
      if (param >= q.target && q.progress < q.target) {
        q.progress = q.target;
        changed = true;
      }
    } else if (q.type === 'victory' && actionType === 'victory') match = true;

    if (match) {
      q.progress = Math.min(q.target, (q.progress || 0) + amount);
      changed = true;
    }
  }

  if (changed) savePlayerQuests(quests);
}

function claimQuestReward(questId) {
  const quests = getPlayerQuests();
  const q = quests.find((item) => item.id === questId);
  if (!q || q.claimed || (q.progress || 0) < q.target) return 0;

  q.claimed = true;
  const reward = q.reward || 100;

  // Добавляем золото в профиль игрока
  try {
    const curGold = parseInt(localStorage.getItem('spore_gold') || localStorage.getItem('spore_td_gold') || '0', 10);
    const newGold = (isNaN(curGold) ? 0 : curGold) + reward;
    localStorage.setItem('spore_gold', String(newGold));
    localStorage.setItem('spore_td_gold', String(newGold));
  } catch (e) {}

  // Авто-генерация: заменяем завершённый квест на новый из пула
  const usedIds = new Set(quests.map((item) => item.id));
  const available = QUEST_POOL.filter((item) => !usedIds.has(item.id));
  if (available.length > 0) {
    const nextQuest = available[Math.floor(Math.random() * available.length)];
    // Через небольшую задержку подставляем новый квест вместо забранного
    const idx = quests.indexOf(q);
    if (idx !== -1) {
      quests[idx] = { ...nextQuest, progress: 0, claimed: false };
    }
  }

  savePlayerQuests(quests);
  return reward;
}

const PROJECTILE_COLOR = 0xf1c40f; // цвет снаряда (жёлтый)
const PROJECTILE_SPEED = 14;       // скорость снаряда
const PROJECTILE_DAMAGE = 20;      // урон за попадание

const START_GOLD = 140;           // стартовое золото игрока
const START_BASE_HP = 1000;       // базовое здоровье базы игрока
const START_LIVES = START_BASE_HP;// обратная совместимость

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

// Процедурные текстуры оружия (1-5 ур.) для башен без отдельных png-файлов (Тесла, Дезинфектор, Снайпер)
function initProceduralWeaponTextures(scene) {
  if (scene.textures.exists('tesla_1') && scene.textures.exists('sniper_1')) return;

  const size = 64;

  // 1. Оружие Теслы (1-5 ур.)
  const teslaDefs = [
    { level: 1, type: 'spark_emitter' },
    { level: 2, type: 'dual_coil' },
    { level: 3, type: 'tesla_coil' },
    { level: 4, type: 'plasmatron' },
    { level: 5, type: 'thunderlord' },
  ];

  teslaDefs.forEach(({ level, type }) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);

    if (type === 'spark_emitter') {
      ctx.fillStyle = '#4a5568';
      ctx.fillRect(cx - 3, cy - 6, 6, 18);
      ctx.fillStyle = '#718096';
      ctx.fillRect(cx - 5, cy + 8, 10, 5);
      const grad = ctx.createRadialGradient(cx, cy - 8, 1, cx, cy - 8, 8);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.5, '#00d2ff');
      grad.addColorStop(1, '#0077b6');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy - 8, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e0f7fa';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy - 8, 11, -0.6, 0.6);
      ctx.stroke();
    } else if (type === 'dual_coil') {
      ctx.fillStyle = '#334155';
      ctx.fillRect(cx - 12, cy + 6, 24, 6);
      const drawCoil = (ox) => {
        ctx.fillStyle = '#b45309';
        ctx.fillRect(ox - 4, cy - 10, 8, 16);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.5;
        for (let y = cy - 8; y <= cy + 4; y += 3) {
          ctx.beginPath();
          ctx.moveTo(ox - 5, y);
          ctx.lineTo(ox + 5, y);
          ctx.stroke();
        }
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(ox, cy - 12, 3.5, 0, Math.PI * 2);
        ctx.fill();
      };
      drawCoil(cx - 6);
      drawCoil(cx + 6);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy - 12);
      ctx.lineTo(cx, cy - 15);
      ctx.lineTo(cx + 6, cy - 12);
      ctx.stroke();
    } else if (type === 'tesla_coil') {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(cx - 8, cy + 8, 16, 5);
      ctx.fillStyle = '#9a3412';
      ctx.fillRect(cx - 4, cy - 6, 8, 14);
      ctx.strokeStyle = '#ea580c';
      ctx.lineWidth = 1.2;
      for (let y = cy - 5; y <= cy + 6; y += 2.5) {
        ctx.beginPath();
        ctx.moveTo(cx - 5, y);
        ctx.lineTo(cx + 5, y);
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(cx, cy - 11);
      ctx.scale(1, 0.45);
      const ringGrad = ctx.createRadialGradient(0, 0, 4, 0, 0, 13);
      ringGrad.addColorStop(0, '#ffffff');
      ringGrad.addColorStop(0.4, '#94a3b8');
      ringGrad.addColorStop(0.8, '#475569');
      ringGrad.addColorStop(1, '#00d2ff');
      ctx.fillStyle = ringGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 13, cy - 12);
      ctx.lineTo(cx - 17, cy - 16);
      ctx.moveTo(cx + 13, cy - 12);
      ctx.lineTo(cx + 17, cy - 16);
      ctx.stroke();
    } else if (type === 'plasmatron') {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cx - 10, cy + 6, 20, 6);
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy + 6);
      ctx.lineTo(cx - 7, cy - 10);
      ctx.lineTo(cx - 2, cy - 15);
      ctx.moveTo(cx + 9, cy + 6);
      ctx.lineTo(cx + 7, cy - 10);
      ctx.lineTo(cx + 2, cy - 15);
      ctx.stroke();
      const pGrad = ctx.createRadialGradient(cx, cy - 4, 1, cx, cy - 4, 10);
      pGrad.addColorStop(0, '#ffffff');
      pGrad.addColorStop(0.3, '#38bdf8');
      pGrad.addColorStop(0.7, '#0284c7');
      pGrad.addColorStop(1, 'rgba(2, 132, 199, 0)');
      ctx.fillStyle = pGrad;
      ctx.beginPath();
      ctx.arc(cx, cy - 4, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy - 4, 3.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'thunderlord') {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cx - 14, cy + 7, 28, 7);
      const drawProng = (ox, h) => {
        ctx.fillStyle = '#334155';
        ctx.fillRect(ox - 2.5, cy - h, 5, h + 7);
        ctx.fillStyle = '#00f5d4';
        ctx.fillRect(ox - 1.5, cy - h - 3, 3, 3);
      };
      drawProng(cx - 10, 12);
      drawProng(cx + 10, 12);
      drawProng(cx, 18);
      ctx.save();
      ctx.translate(cx, cy - 3);
      ctx.scale(1, 0.5);
      ctx.strokeStyle = '#00f5d4';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      const tGrad = ctx.createRadialGradient(cx, cy - 3, 1, cx, cy - 3, 9);
      tGrad.addColorStop(0, '#ffffff');
      tGrad.addColorStop(0.4, '#00f5d4');
      tGrad.addColorStop(0.8, '#00bbf9');
      tGrad.addColorStop(1, 'rgba(0, 187, 249, 0)');
      ctx.fillStyle = tGrad;
      ctx.beginPath();
      ctx.arc(cx, cy - 3, 9, 0, Math.PI * 2);
      ctx.fill();
    }

    scene.textures.addCanvas(`tesla_${level}`, canvas);
  });

  // 2. Оружие Дезинфектора (1-5 ур.)
  const disDefs = [
    { level: 1, type: 'spray_can' },
    { level: 2, type: 'sprayer_nozzle' },
    { level: 3, type: 'gas_mortar' },
    { level: 4, type: 'chem_blower' },
    { level: 5, type: 'bio_purifier' },
  ];

  disDefs.forEach(({ level, type }) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);

    if (type === 'spray_can') {
      ctx.fillStyle = '#1b4332';
      ctx.fillRect(cx - 5, cy - 4, 10, 16);
      ctx.fillStyle = '#2d6a4f';
      ctx.fillRect(cx - 3, cy - 8, 6, 4);
      ctx.fillStyle = '#d8f3dc';
      ctx.fillRect(cx + 1, cy - 7, 5, 2);
    } else if (type === 'sprayer_nozzle') {
      ctx.fillStyle = '#2d6a4f';
      ctx.fillRect(cx - 7, cy - 2, 14, 14);
      ctx.strokeStyle = '#95d5b2';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 2);
      ctx.lineTo(cx + 6, cy - 8);
      ctx.stroke();
      ctx.fillStyle = '#52b788';
      ctx.beginPath();
      ctx.arc(cx + 7, cy - 9, 3.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'gas_mortar') {
      ctx.fillStyle = '#1b4332';
      ctx.fillRect(cx - 8, cy + 2, 16, 10);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = '#40916c';
      ctx.fillRect(-5, -14, 10, 16);
      ctx.strokeStyle = '#74c69d';
      ctx.lineWidth = 2;
      ctx.strokeRect(-5, -14, 10, 16);
      ctx.restore();
    } else if (type === 'chem_blower') {
      ctx.fillStyle = '#081c15';
      ctx.fillRect(cx - 9, cy + 4, 18, 8);
      ctx.fillStyle = '#52b788';
      ctx.fillRect(cx - 7, cy - 10, 5, 14);
      ctx.fillRect(cx + 2, cy - 10, 5, 14);
      ctx.fillStyle = '#b7e4c7';
      ctx.beginPath();
      ctx.arc(cx - 4.5, cy - 11, 2.5, 0, Math.PI * 2);
      ctx.arc(cx + 4.5, cy - 11, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'bio_purifier') {
      ctx.fillStyle = '#081c15';
      ctx.fillRect(cx - 10, cy + 5, 20, 7);
      const bGrad = ctx.createRadialGradient(cx, cy - 5, 1, cx, cy - 5, 8);
      bGrad.addColorStop(0, '#d8f3dc');
      bGrad.addColorStop(0.5, '#52b788');
      bGrad.addColorStop(1, '#1b4332');
      ctx.fillStyle = bGrad;
      ctx.beginPath();
      ctx.arc(cx, cy - 5, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#74c69d';
      ctx.fillRect(cx + 6, cy - 7, 5, 4);
    }

    scene.textures.addCanvas(`disinfector_${level}`, canvas);
  });

  // 3. Оружие Снайпера (1-5 ур.)
  const sniperDefs = [
    { level: 1, type: 'sks' },
    { level: 2, type: 'svd' },
    { level: 3, type: 'vss' },
    { level: 4, type: 'barrett' },
    { level: 5, type: 'railgun' },
  ];

  sniperDefs.forEach(({ level, type }) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);

    if (type === 'sks') {
      // СКС: классическая деревянная ложа, длинный тонкий ствол
      ctx.fillStyle = '#8b5a2b';
      ctx.fillRect(cx - 3, cy - 4, 6, 16);
      ctx.fillStyle = '#334155';
      ctx.fillRect(cx - 2, cy - 16, 4, 18);
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(cx - 1, cy - 18, 2, 4);
    } else if (type === 'svd') {
      // СВД: рамочный приклад, длинный ствол с пламегасителем, оптический прицел ПСО-1
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(cx - 3, cy - 2, 6, 18);
      ctx.fillStyle = '#475569';
      ctx.fillRect(cx - 2, cy - 19, 4, 20);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cx + 2, cy - 8, 4, 11);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(cx + 3, cy - 9, 2, 2);
    } else if (type === 'vss') {
      // ВСС Винторез: массивный интегрированный глушитель, прицел
      ctx.fillStyle = '#854d0e';
      ctx.fillRect(cx - 4, cy + 2, 8, 14);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(cx - 3, cy - 17, 6, 21);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cx + 3, cy - 7, 4, 10);
      ctx.fillStyle = '#00d2ff';
      ctx.fillRect(cx + 4, cy - 8, 2, 2);
    } else if (type === 'barrett') {
      // Barrett M82 .50 BMG: массивный дульный тормоз, крупная оптика
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(cx - 4, cy - 3, 8, 18);
      ctx.fillStyle = '#475569';
      ctx.fillRect(cx - 3, cy - 21, 6, 22);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cx - 5, cy - 23, 10, 4);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cx + 3, cy - 10, 5, 13);
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(cx + 4, cy - 11, 3, 2);
    } else if (type === 'railgun') {
      // Рельсотрон 'Гарпун': параллельные рельсы, неоновый разряд
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cx - 5, cy + 4, 10, 10);
      ctx.fillStyle = '#334155';
      ctx.fillRect(cx - 4, cy - 20, 3, 26);
      ctx.fillRect(cx + 1, cy - 20, 3, 26);
      const grad = ctx.createLinearGradient(cx, cy - 20, cx, cy + 4);
      grad.addColorStop(0, '#00f5d4');
      grad.addColorStop(0.5, '#00bbf9');
      grad.addColorStop(1, '#7b2cbf');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - 1, cy - 19, 2, 24);
    }

    scene.textures.addCanvas(`sniper_${level}`, canvas);
  });
}

// ------------- Скруглённые фоны кнопок и окон -------------
// Phaser не умеет скруглять фон у Text/Rectangle, поэтому рисуем скруглённый
// прямоугольник графикой. Для объектов внутри контейнеров фон добавляем в тот же
// контейнер (под объект) — тогда масштаб/позиция совпадают; для сценных — с учётом scrollFactor.
function isVisibleDeep(obj) {
  let o = obj;
  while (o) {
    if (o.visible === false || (o.alpha !== undefined && o.alpha <= 0.001)) return false;
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
      if (obj.setStyle) obj.setStyle({ backgroundColor: 'rgba(0,0,0,0)' });
      if (obj.style) obj.style.backgroundColor = 'rgba(0,0,0,0)';
      if (obj.updateText) obj.updateText();
    } catch (error) {
      /* не критично */
    }
  } else {
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

function updateRoundBgs(scene) {
  const list = scene._roundBgs;
  if (!list) return;
  for (const it of list) {
    const o = it.obj;
    if (!o || !o.scene) continue;

    // Синхронизируем контейнер: фон ВСЕГДА должен быть в том же контейнере прямо под элементом
    if (o.parentContainer) {
      if (it.g.parentContainer !== o.parentContainer) {
        const idx = o.parentContainer.getIndex(o);
        o.parentContainer.addAt(it.g, Math.max(0, idx));
      }
    } else if (it.g.parentContainer) {
      it.g.parentContainer.remove(it.g);
      scene.children.add(it.g);
    }

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
  if (!route || !route.segments) return Infinity;
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
    const speedMult = (scene && scene.diffDef && scene.diffDef.speedMultiplier) || 1;
    this.speed = type.speed * speedMult;     // скорость: world units/sec
    const rewMult = (scene && scene.diffDef && scene.diffDef.rewardMultiplier) || 1;
    this.reward = Math.max(1, Math.round(type.reward * rewMult));   // золото за убийство
    this.sizeFactor = type.size; // размер относительно клетки
    this.damageMultiplier = type.damageMultiplier || 1; // броня (множитель урона)
    this.shield = shield;        // запас щита (снимается первым)
    this.maxShield = shield;     // изначальный щит (для отображения)
    this.regen = type.regen || 0; // споровая регенерация HP/с

    // Маршрут и непрерывная мировая позиция.
    this.route = route;
    this.segment = 0;
    this.progress = 0;
    this.wx = (route && route.waypoints && route.waypoints[0]) ? route.waypoints[0].x : ROUTE_WAYPOINTS[0].x;
    this.wy = (route && route.waypoints && route.waypoints[0]) ? route.waypoints[0].y : ROUTE_WAYPOINTS[0].y;
    this.dirX = 0;
    this.dirY = 0;

    this.hp = hp;               // здоровье (по умолчанию базовое)
    this.maxHp = hp;            // максимум здоровья (для отображения)
    this.isDead = false;        // мёртв/исчезает — не двигается и не цель для башен
    this.isCured = false;       // излечен газом дезинфектора — идёт назад и бьёт споры

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

  // Излечение врага газом: меняет цвет, вспыхивает и начинает обратное движение.
  cure() {
    if (this.isDead || this.isCured) return;
    this.isCured = true;
    this.baseFill = 0x2ecc71; // чистый зеленый оттенок очищенных клеток
    this.setFillStyle(this.baseFill);
    this.flash();

    if (this.scene && this.scene.showFloatingText) {
      this.scene.showFloatingText(this.x, this.y - 18 * DPR, 'ВЫЛЕЧЕН!', 0x2ecc71);
    }
  }

  // Движение назад к спавну (для излеченных врагов).
  moveBackwards(delta) {
    const segments = this.route.segments;
    let seg = segments[this.segment];
    this.progress -= (this.speed * (delta / 1000)) / seg.length;

    while (this.progress < 0 && this.segment > 0) {
      this.segment -= 1;
      seg = segments[this.segment];
      this.progress += 1;
    }

    if (this.segment === 0 && this.progress <= 0) {
      this.progress = 0;
      this.wx = seg.a.x;
      this.wy = seg.a.y;
      this.dirX = -seg.dir.x;
      this.dirY = -seg.dir.y;
      this.syncScreen();
      this.arriveAtStart();
      return;
    }

    seg = segments[this.segment];
    this.wx = Phaser.Math.Linear(seg.a.x, seg.b.x, this.progress);
    this.wy = Phaser.Math.Linear(seg.a.y, seg.b.y, this.progress);
    this.dirX = -seg.dir.x;
    this.dirY = -seg.dir.y;
    this.syncScreen();
  }

  // Излеченный враг дошёл назад до входа — спасается и приносит золото.
  arriveAtStart() {
    this.isDead = true;
    if (this.scene) {
      this.scene.gold += this.reward;
      this.scene.updateUI();
      if (this.scene.showFloatingText) {
        this.scene.showFloatingText(this.x, this.y - 20 * DPR, `+${this.reward}`, 0xffd700);
      }
    }
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      scale: 1.5,
      duration: 300,
      ease: 'Quad.easeOut',
      onComplete: () => this.destroy(),
    });
  }

  // Бой излеченного врага со встречными заражёнными спорами.
  checkFriendlyCombat(delta) {
    if (!this.isCured || this.isDead || !this.scene) return;

    const contactRange = (this.sizeFactor || 0.6) * 0.45;
    for (const other of this.scene.enemies) {
      if (!other.active || other.isDead || other.isCured) continue;

      const dist = Math.hypot(this.wx - other.wx, this.wy - other.wy);
      if (dist <= contactRange + (other.sizeFactor || 0.6) * 0.45) {
        const dps = 55;
        const dmg = dps * (delta / 1000);
        other.takeDamage(dmg);
        this.takeDamage(dmg);

        if (this.isDead) break;
      }
    }
  }

  // Движение по сегментам Route в world-координатах.
  // delta — мс; экранные координаты в логике движения не участвуют.
  moveAlongPath(delta) {
    if (this.isCured) {
      this.moveBackwards(delta);
      this.checkFriendlyCombat(delta);
      return;
    }

    // Споровая регенерация тканей
    if (this.regen > 0 && !this.isDead && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + this.regen * (delta / 1000));
    }

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
  // Броня (damageMultiplier) уменьшает входящий урон (если не указано ignoreArmor).
  takeDamage(amount, ignoreArmor = false) {
    if (this.isDead) return;

    const damage = ignoreArmor ? amount : amount * this.damageMultiplier;

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
    if (!this.isCured) {
      this.scene.onEnemyKilled(this); // сообщаем сцене (награда золотом)
      // Разделяющийся враг оставляет после себя мелких.
      if (this.config.splitInto) this.scene.onEnemySplit(this);
    }

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

// Расстояние от точки (px, py) до отрезка [(x1, y1), (x2, y2)] — защита от туннелирования пуль
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ------------------------------ Снаряд ------------------------------
// Баллистический снаряд: летит по прямой траектории с расчётом процента точности (Accuracy).
// При точном выстреле гарантированно поражает цель; при промахе отклоняется и выводит MISS.
class Projectile extends Phaser.GameObjects.Arc {
  constructor(scene, x, y, angle, speed, maxDistance, damage = PROJECTILE_DAMAGE, tower = null, isMiss = false, targetEnemy = null) {
    const isRailgun = tower && tower.typeKey === 'sniper' && tower.level === 5;
    const isSniper = tower && tower.typeKey === 'sniper';
    const bulletRadius = isRailgun
      ? Math.max(4.5, ISO_HW * 0.09 * DPR)
      : (isSniper ? Math.max(3.6, ISO_HW * 0.075 * DPR) : Math.max(3.2, ISO_HW * 0.065 * DPR));
    const bulletColor = isRailgun ? 0x00f5d4 : (isSniper ? 0xffea79 : PROJECTILE_COLOR);
    super(scene, x, y, bulletRadius, 0, 360, false, bulletColor);

    this.angleRad = angle;
    this.speed = speed;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.maxDistance = maxDistance;
    this.distanceTraveled = 0;
    this.damage = damage;
    this.tower = tower;
    this.isMiss = isMiss;
    this.targetEnemy = targetEnemy;
    this.hitRadius = Math.max(10 * DPR, 11);
    this.missTriggerDist = targetEnemy ? Math.hypot(targetEnemy.x - x, targetEnemy.y - y) : maxDistance * 0.5;
    this.hasShownMiss = false;

    scene.add.existing(this);
    this.setDepth(50); // снаряды поверх мира (ниже UI 90+)
  }

  // Полёт пули: надёжное попадание при точном выстреле и визуальный увод с текстом MISS при промахе
  flyToTarget(delta) {
    const dt = delta / 1000;
    const step = this.speed * dt;

    const prevX = this.x;
    const prevY = this.y;

    // При точном выстреле (!this.isMiss) снаряд уверенно наводится на ведущую цель,
    // исключая промахи из-за времени полёта по быстрым врагам (классическая TDS точность)
    if (!this.isMiss && this.targetEnemy && this.targetEnemy.active && !this.targetEnemy.isDead && !this.targetEnemy.isCured) {
      const enemyRadius = (this.targetEnemy.sizeFactor ? this.targetEnemy.sizeFactor * ISO_HW * 0.55 : 18);
      const hitThreshold = enemyRadius + this.hitRadius;
      const distToTarget = Math.hypot(this.targetEnemy.x - this.x, this.targetEnemy.y - this.y);

      if (distToTarget <= hitThreshold || distToTarget <= step) {
        this.x = this.targetEnemy.x;
        this.y = this.targetEnemy.y;
        this.targetEnemy.takeDamage(this.damage);
        if (this.scene.createHitSpark) {
          this.scene.createHitSpark(this.x, this.y);
        }
        this.destroy();
        return;
      }

      const toAngle = Math.atan2(this.targetEnemy.y - this.y, this.targetEnemy.x - this.x);
      this.vx = Math.cos(toAngle) * this.speed;
      this.vy = Math.sin(toAngle) * this.speed;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.distanceTraveled += step;

    // При промахе: когда пуля преодолевает дистанцию до цели, отображаем всплывающий текст 'MISS'
    if (this.isMiss && !this.hasShownMiss && this.distanceTraveled >= this.missTriggerDist) {
      this.hasShownMiss = true;
      const target = this.targetEnemy;
      if (target && target.active && !target.isDead && !target.isCured) {
        if (this.scene.showFloatingText && (!target._lastMissText || Date.now() - target._lastMissText > 220)) {
          target._lastMissText = Date.now();
          this.scene.showFloatingText(target.x, target.y - 12 * DPR, 'MISS', '#94a3b8');
        }
      }
    }

    // Проверяем непрерывное физическое попадание вдоль отрезка полёта пули
    let hitEnemy = null;
    let closestDist = Infinity;

    for (const enemy of this.scene.enemies) {
      if (!enemy.active || enemy.isDead || enemy.isCured) continue;
      const ex = enemy.x;
      const ey = enemy.y;
      const enemyRadius = (enemy.sizeFactor ? enemy.sizeFactor * ISO_HW * 0.55 : 18);
      const hitThreshold = enemyRadius + this.hitRadius;
      const d = distToSegment(ex, ey, prevX, prevY, this.x, this.y);
      if (d <= hitThreshold && d < closestDist) {
        closestDist = d;
        hitEnemy = enemy;
      }
    }

    if (hitEnemy) {
      if (this.isMiss) {
        // Промах: пуля задела врага на излёте, но урон не наносится
        if (this.scene.showFloatingText && (!hitEnemy._lastMissText || Date.now() - hitEnemy._lastMissText > 220)) {
          hitEnemy._lastMissText = Date.now();
          this.scene.showFloatingText(hitEnemy.x, hitEnemy.y - 12 * DPR, 'MISS', '#94a3b8');
        }
        this.destroy();
        return;
      }
      hitEnemy.takeDamage(this.damage);
      if (this.scene.createHitSpark) {
        this.scene.createHitSpark(this.x, this.y);
      }
      this.destroy();
      return;
    }

    // Достигли предельной дистанции полёта или улетели за экран
    if (this.distanceTraveled >= this.maxDistance) {
      if (this.isMiss && !this.hasShownMiss && this.targetEnemy && this.targetEnemy.active && !this.targetEnemy.isDead && !this.targetEnemy.isCured) {
        this.hasShownMiss = true;
        if (this.scene.showFloatingText && (!this.targetEnemy._lastMissText || Date.now() - this.targetEnemy._lastMissText > 220)) {
          this.targetEnemy._lastMissText = Date.now();
          this.scene.showFloatingText(this.targetEnemy.x, this.targetEnemy.y - 12 * DPR, 'MISS', '#94a3b8');
        }
      }
      this.destroy();
    }
  }
}

// Получить текущий надетый облик для турели (скины отключены)
function getEquippedTowerSkin(typeKey) {
  return { id: 'default', tint: null };
}

// ------------------------------ Башня ------------------------------
// Башня хранит своё место на сетке, радиус атаки и перезарядку.
class Tower {
  constructor(scene, gx, gy, typeKey = 'gunner') {
    const type = TOWER_TYPES[typeKey] || TOWER_TYPES.gunner;
    const lvl1 = type.levels ? type.levels[0] : null;

    this.scene = scene;
    this.gx = gx; // центр башни в клетках (может быть дробным)
    this.gy = gy;
    this.typeKey = typeKey;          // ключ типа ("gunner", "minigun", ...)
    this.config = type;              // настройки типа
    this.level = 1;                  // уровень башни
    this.range = lvl1 ? lvl1.range : type.range;         // радиус атаки, клеток
    this.fireRate = lvl1 ? lvl1.fireRate : type.fireRate;   // выстрелов в секунду
    this.damage = lvl1 ? lvl1.damage : type.damage;       // урон за выстрел
    this.accuracy = lvl1 && lvl1.accuracy !== undefined ? lvl1.accuracy : (type.accuracy !== undefined ? type.accuracy : 1.0);
    this.bulletSpeed = lvl1 && lvl1.bulletSpeed !== undefined ? lvl1.bulletSpeed : (type.bulletSpeed || 14);
    this.cureChance = lvl1 && lvl1.cureChance !== undefined ? lvl1.cureChance : (type.cureChance || 0);
    this.sprayCone = lvl1 && lvl1.sprayCone !== undefined ? lvl1.sprayCone : (type.sprayCone || null);
    this.continuous = Boolean(lvl1 && lvl1.continuous);
    this.dualBarrels = Boolean(lvl1 && lvl1.dualBarrels);
    this.chainCount = lvl1 && lvl1.chainCount !== undefined ? lvl1.chainCount : (type.chainCount || 1);
    this.chainRange = lvl1 && lvl1.chainRange !== undefined ? lvl1.chainRange : (type.chainRange || 2.4);
    this.splashRadius = lvl1 && lvl1.splashRadius !== undefined ? lvl1.splashRadius : (type.splashRadius || 0);
    this.arc = lvl1 && lvl1.arc ? lvl1.arc : null;
    this.mountAngle = dirToAngle(DIR_FORWARD); // базовый угол наведения/установки
    this.hasRotated = false;         // развернули ли установку (доступно только 1 раз)
    this.isAiming = false;           // в процессе ручного разворота игроком
    this.cooldown = 0;               // время до следующего выстрела, сек
    this.totalSpent = type.cost;     // сколько золота вложено (для продажи)
    this.aimAngle = dirToAngle(DIR_FORWARD); // куда направлена пушка (радианы)
    this.aimDir = DIR_FORWARD;       // направление пушки (одно из 8)
    this.baseAngle = dirToAngle(DIR_FORWARD); // направление корпуса (радианы)
    this.baseDir = DIR_FORWARD;      // направление корпуса (одно из 8)
    this.sprite = null;              // картинка пушки (вращается)
    this.baseSprite = null;          // картинка корпуса (стоит на месте)
  }

  // Название текущего оружия
  getWeaponName() {
    const lvl = this.config.levels && this.config.levels[this.level - 1];
    return lvl ? lvl.name : this.config.name;
  }

  // Название оружия следующего уровня
  getNextWeaponName() {
    if (!this.canUpgrade()) return null;
    const next = this.config.levels && this.config.levels[this.level];
    return next ? next.name : null;
  }

  // Инициализация угла установки стационарного орудия
  initMountAngle() {
    if (this.aimAngle !== undefined && this.aimAngle !== dirToAngle(DIR_FORWARD)) {
      this.mountAngle = Math.atan2(Math.sin(this.aimAngle) / ISO_HH, Math.cos(this.aimAngle) / ISO_HW);
    } else {
      let bestDist = Infinity;
      let bestAngle = dirToAngle(DIR_FORWARD);
      const pos = this.getPosition();
      const waypoints = (this.scene && this.scene.mapDef && this.scene.mapDef.waypoints) || ROUTE_WAYPOINTS;
      for (const wp of waypoints) {
        const wpScreen = worldToScreen(wp.x, wp.y);
        const d = Math.hypot(wp.x - this.gx, wp.y - this.gy);
        if (d < bestDist) {
          bestDist = d;
          bestAngle = Math.atan2((wpScreen.y - pos.y) / ISO_HH, (wpScreen.x - pos.x) / ISO_HW);
        }
      }
      this.mountAngle = bestAngle;
    }
    const screenMount = Math.atan2(Math.sin(this.mountAngle) * ISO_HH, Math.cos(this.mountAngle) * ISO_HW);
    this.baseAngle = screenMount;
    this.baseDir = angleToDir(screenMount);
    this.aimAngle = screenMount;
    this.aimDir = this.baseDir;
  }

  // Установить угол стационарного сектора (любой угол на поле)
  setMountAngle(angle) {
    this.mountAngle = angle;
    const screenMount = Math.atan2(Math.sin(angle) * ISO_HH, Math.cos(angle) * ISO_HW);
    this.baseAngle = screenMount;
    this.baseDir = angleToDir(screenMount);
    this.aimAngle = screenMount;
    this.aimDir = this.baseDir;
  }

  // Поворот стационарного сектора на угол rad
  rotateArc(rad = Math.PI / 4) {
    if (!this.arc) return;
    this.mountAngle = (this.mountAngle + rad) % (Math.PI * 2);
    if (this.mountAngle < -Math.PI) this.mountAngle += Math.PI * 2;
    if (this.mountAngle > Math.PI) this.mountAngle -= Math.PI * 2;
    const screenMount = Math.atan2(Math.sin(this.mountAngle) * ISO_HH, Math.cos(this.mountAngle) * ISO_HW);
    this.baseAngle = screenMount;
    this.baseDir = angleToDir(screenMount);
    this.aimAngle = screenMount;
    this.aimDir = this.baseDir;
  }

  // Цена следующего улучшения (зависит от конфигурации уровней).
  getUpgradeCost() {
    if (!this.canUpgrade()) return 0;
    const next = this.config.levels && this.config.levels[this.level];
    return next ? next.upgradeCost : Math.round(this.config.cost * 0.8) * this.level;
  }

  // Сколько золота вернётся при продаже.
  getSellValue() {
    return Math.floor(this.totalSpent * TOWER_SELL_RATIO);
  }

  // Можно ли ещё улучшать башню.
  canUpgrade() {
    return this.level < TOWER_MAX_LEVEL;
  }

  // Улучшение башни под конкретный уровень из levels.
  upgrade(cost) {
    if (!this.canUpgrade()) return;
    this.level += 1;
    const lvl = this.config.levels && this.config.levels[this.level - 1];
    if (lvl) {
      this.range = lvl.range;
      this.fireRate = lvl.fireRate !== undefined ? lvl.fireRate : this.config.fireRate;
      this.damage = lvl.damage;
      this.accuracy = lvl.accuracy !== undefined ? lvl.accuracy : (this.config.accuracy !== undefined ? this.config.accuracy : 1.0);
      this.bulletSpeed = lvl.bulletSpeed !== undefined ? lvl.bulletSpeed : (this.config.bulletSpeed || 14);
      this.cureChance = lvl.cureChance !== undefined ? lvl.cureChance : (this.config.cureChance || 0);
      this.sprayCone = lvl.sprayCone !== undefined ? lvl.sprayCone : (this.config.sprayCone || null);
      this.continuous = Boolean(lvl.continuous);
      this.dualBarrels = Boolean(lvl.dualBarrels);
      this.chainCount = lvl.chainCount !== undefined ? lvl.chainCount : (this.config.chainCount || 1);
      this.chainRange = lvl.chainRange !== undefined ? lvl.chainRange : (this.config.chainRange || 2.4);
      this.splashRadius = lvl.splashRadius !== undefined ? lvl.splashRadius : (this.config.splashRadius || 0);
      const hadArc = Boolean(this.arc);
      this.arc = lvl.arc || null;
      if (this.arc && !hadArc) {
        this.initMountAngle();
        this.hasRotated = false;
      }
    } else {
      this.range += 0.4;
      this.fireRate += 0.3;
      this.damage += 1;
    }
    this.totalSpent += cost;
  }

  // Позиция на экране (iso) из world-координат.
  getPosition() {
    return worldToScreen(this.gx, this.gy);
  }

  // Обновление башни: перезарядка, поиск цели, наведение, выстрел.
  update(delta, enemies) {
    if (this.isAiming) {
      // Пока игрок крутит башню вручную — она не ищет цели и не стреляет
      return;
    }

    // Для башен с непрерывным потоком (без кд)
    if (this.continuous) {
      this.updateContinuous(delta, enemies);
      return;
    }

    this.cooldown -= delta / 1000;

    const pos = this.getPosition();
    const target = this.findTarget(enemies);

    // Наводим пушку на цель в пределах сектора (если есть ограничение arc)
    if (target) {
      this.aimAngle = Math.atan2(target.y - pos.y, target.x - pos.x);
      this.aimDir = angleToDir(this.aimAngle, this.aimDir);
      if (!this.arc) {
        this.baseAngle = this.aimAngle;
        this.baseDir = angleToDir(this.baseAngle, this.baseDir);
      } else {
        const screenMount = Math.atan2(Math.sin(this.mountAngle) * ISO_HH, Math.cos(this.mountAngle) * ISO_HW);
        this.baseAngle = screenMount;
        this.baseDir = angleToDir(screenMount, this.baseDir);
      }
    } else if (this.arc) {
      // Для стационарной установки крепление ВСЕГДА смотрит строго по mountAngle.
      // А пулемёт запоминает последнее направление, куда стрелял, и не меняет положение!
      const screenMount = Math.atan2(Math.sin(this.mountAngle) * ISO_HH, Math.cos(this.mountAngle) * ISO_HW);
      this.baseAngle = screenMount;
      this.baseDir = angleToDir(screenMount, this.baseDir);
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
  // из тех, кто в радиусе (и в секторе обстрела, если задан arc).
  findTarget(enemies) {
    let best = null;
    let bestLead = -Infinity;
    const pos = this.getPosition();

    for (const enemy of enemies) {
      if (!enemy.active || enemy.isDead || enemy.isCured) continue;

      const distance = Math.hypot(this.gx - enemy.wx, this.gy - enemy.wy);
      if (distance > this.range) continue;

      if (this.arc) {
        const enemyAngle = Math.atan2((enemy.y - pos.y) / ISO_HH, (enemy.x - pos.x) / ISO_HW);
        if (Math.abs(angleDiff(enemyAngle, this.mountAngle)) > this.arc / 2) {
          continue;
        }
      }

      const lead = enemy.segment + enemy.progress;
      if (lead > bestLead) {
        bestLead = lead;
        best = enemy;
      }
    }

    return best;
  }

  // Физическая стрельба снарядом прямой баллистической траекторией с угловым разбросом.
  shoot(pos, target) {
    if (this.typeKey === 'disinfector') {
      this.shootGas(pos, target);
      return;
    }

    if (this.typeKey === 'tesla') {
      this.shootChainLightning(pos, target);
      return;
    }

    // Троттлинг звука выстрела, чтобы при скорострельности 10–25/с звук не трещал
    const now = Date.now();
    if (!this.lastShotSound || now - this.lastShotSound >= 75) {
      this.scene.playSfx('sfx_shot', 0.18);
      this.lastShotSound = now;
    }

    if (this.dualBarrels) {
      this.shootDual(pos, target);
      return;
    }

    const baseAngle = Math.atan2(target.y - pos.y, target.x - pos.x);
    const accuracy = this.accuracy !== undefined ? this.accuracy : 1.0;
    const isHit = Math.random() <= accuracy;

    // При точном выстреле снаряд летит прямо в цель; при промахе отклоняется в сторону
    let shotAngle = baseAngle;
    if (!isHit) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const deflection = (0.16 + Math.random() * 0.10) * side;
      shotAngle = baseAngle + deflection;
    }

    const bulletSpeed = (this.bulletSpeed || 14) * ISO_HW;
    const rangePx = this.range * ISO_HW * Math.SQRT2 * 1.15;

    const projectile = new Projectile(this.scene, pos.x, pos.y, shotAngle, bulletSpeed, rangePx, this.damage, this, !isHit, target);
    this.scene.projectiles.push(projectile);
  }

  // Стрельба цепной молнией (бьёт главную цель и перескакивает по цепочке на ближайших врагов)
  shootChainLightning(pos, target) {
    this.scene.playSfx('sfx_shot', 0.22);

    const hitTargets = [target];
    const maxChains = this.chainCount || 2;
    const chainRange = this.chainRange || 2.4;

    let current = target;
    for (let c = 1; c < maxChains; c++) {
      let nearest = null;
      let minDist = chainRange;
      for (const enemy of this.scene.enemies) {
        if (!enemy.active || enemy.isDead || enemy.isCured || hitTargets.includes(enemy)) continue;
        const d = Math.hypot(enemy.wx - current.wx, enemy.wy - current.wy);
        if (d < minDist) {
          minDist = d;
          nearest = enemy;
        }
      }
      if (!nearest) break;
      hitTargets.push(nearest);
      current = nearest;
    }

    // Наносим урон поражённым врагам по цепочке
    for (let i = 0; i < hitTargets.length; i++) {
      const enemy = hitTargets[i];
      const decay = Math.pow(0.9, i);
      enemy.takeDamage(this.damage * decay);
    }

    if (this.scene.createChainLightningVisual) {
      this.scene.createChainLightningVisual(pos, hitTargets);
    }
  }

  // Стрельба из двух независимых параллельных стволов (спаренный миниган)
  shootDual(pos, target) {
    const perpAngle = this.aimAngle + Math.PI / 2;
    const barrelSpacing = 7 * DPR;

    const leftX = pos.x + Math.cos(perpAngle) * barrelSpacing;
    const leftY = pos.y + Math.sin(perpAngle) * barrelSpacing * (ISO_HH / ISO_HW);

    const rightX = pos.x - Math.cos(perpAngle) * barrelSpacing;
    const rightY = pos.y - Math.sin(perpAngle) * barrelSpacing * (ISO_HH / ISO_HW);

    const accuracy = this.accuracy !== undefined ? this.accuracy : 1.0;
    const bulletSpeed = (this.bulletSpeed || 14) * ISO_HW;
    const rangePx = this.range * ISO_HW * Math.SQRT2 * 1.15;

    // Ствол 1 (левый)
    const isHit1 = Math.random() <= accuracy;
    const baseAngle1 = Math.atan2(target.y - leftY, target.x - leftX);
    const shotAngle1 = isHit1 ? baseAngle1 : baseAngle1 + (Math.random() < 0.5 ? 1 : -1) * (0.16 + Math.random() * 0.10);
    const p1 = new Projectile(this.scene, leftX, leftY, shotAngle1, bulletSpeed, rangePx, this.damage, this, !isHit1, target);
    this.scene.projectiles.push(p1);

    // Ствол 2 (правый)
    const isHit2 = Math.random() <= accuracy;
    const baseAngle2 = Math.atan2(target.y - rightY, target.x - rightX);
    const shotAngle2 = isHit2 ? baseAngle2 : baseAngle2 + (Math.random() < 0.5 ? 1 : -1) * (0.16 + Math.random() * 0.10);
    const p2 = new Projectile(this.scene, rightX, rightY, shotAngle2, bulletSpeed, rangePx, this.damage, this, !isHit2, target);
    this.scene.projectiles.push(p2);
  }

  // Непрерывный поток газа без перезарядки (для финального уровня дезинфектора).
  updateContinuous(delta, enemies) {
    const pos = this.getPosition();
    const target = this.findTarget(enemies);

    if (!target) return;

    this.aimAngle = Math.atan2(target.y - pos.y, target.x - pos.x);
    this.aimDir = angleToDir(this.aimAngle, this.aimDir);
    if (!this.arc) {
      this.baseAngle = this.aimAngle;
      this.baseDir = angleToDir(this.baseAngle, this.baseDir);
    } else {
      const screenMount = Math.atan2(Math.sin(this.mountAngle) * ISO_HH, Math.cos(this.mountAngle) * ISO_HW);
      this.baseAngle = screenMount;
      this.baseDir = angleToDir(screenMount, this.baseDir);
    }

    const weaponScale = this.config.weaponScale || 1;
    const muzzleDistance = this.config.footprint * weaponScale * 0.5 * ISO_HW;
    const muzzle = {
      x: pos.x + Math.cos(this.aimAngle) * muzzleDistance,
      y: pos.y + Math.sin(this.aimAngle) * muzzleDistance,
    };

    // Звук распыления (проигрываем периодически, чтобы не спамить каждый кадр)
    this.soundTimer = (this.soundTimer || 0) - delta;
    if (this.soundTimer <= 0) {
      this.scene.playSfx('sfx_shot', 0.08);
      this.soundTimer = 160;
    }

    // Непрерывная струя газа
    if (this.scene.createContinuousGasSpray) {
      this.scene.createContinuousGasSpray(muzzle.x, muzzle.y, this.aimAngle, this.range * ISO_HW * 0.7);
    }

    const cone = this.sprayCone || ((45 * Math.PI) / 180);
    const frameDamage = this.damage * (delta / 1000);
    const splashRadius = this.splashRadius || 1.4;

    for (const enemy of this.scene.enemies) {
      if (!enemy.active || enemy.isDead || enemy.isCured) continue;

      const dist = Math.hypot(this.gx - enemy.wx, this.gy - enemy.wy);
      if (dist > this.range + splashRadius) continue;

      const enemyAngle = Math.atan2((enemy.y - pos.y) / ISO_HH, (enemy.x - pos.x) / ISO_HW);
      const diff = Math.abs(angleDiff(enemyAngle, this.aimAngle));
      const distToTarget = target ? Math.hypot(enemy.wx - target.wx, enemy.wy - target.wy) : Infinity;

      if (diff <= cone / 2 || enemy === target || distToTarget <= splashRadius) {
        // Урон сквозь броню, масштабируемый био-сопротивлением от степени заражения
        const gasMult = getEnemyGasDamageMultiplier(enemy);
        enemy.takeDamage(frameDamage * gasMult, true);

        if (!enemy.isDead && !enemy.isCured) {
          const mult = getEnemyCureMultiplier(enemy);
          const frameChance = (this.cureChance || 0.35) * mult * (delta / 1000);
          if (frameChance > 0 && Math.random() < frameChance) {
            enemy.cure();
          }
        }
      }
    }
  }

  // Распыление струи дезинфицирующего газа (конус перед башней + сплеш вокруг цели).
  shootGas(pos, target) {
    this.scene.playSfx('sfx_shot', 0.12);
    const aimAngle = this.aimAngle;
    const cone = this.sprayCone || ((45 * Math.PI) / 180);
    const rangePx = this.range * ISO_HW;
    const splashRadius = this.splashRadius || 1.2;

    if (this.scene.createGasSpray) {
      this.scene.createGasSpray(pos.x, pos.y, aimAngle, rangePx * 0.7, this.level);
    }

    for (const enemy of this.scene.enemies) {
      if (!enemy.active || enemy.isDead || enemy.isCured) continue;

      const dist = Math.hypot(this.gx - enemy.wx, this.gy - enemy.wy);
      if (dist > this.range + splashRadius) continue;

      const enemyAngle = Math.atan2((enemy.y - pos.y) / ISO_HH, (enemy.x - pos.x) / ISO_HW);
      const diff = Math.abs(angleDiff(enemyAngle, aimAngle));
      const distToTarget = target ? Math.hypot(enemy.wx - target.wx, enemy.wy - target.wy) : Infinity;

      if (diff <= cone / 2 || enemy === target || distToTarget <= splashRadius) {
        // Урон сквозь броню с учётом степени заражения спорами
        const gasMult = getEnemyGasDamageMultiplier(enemy);
        enemy.takeDamage(this.damage * gasMult, true);

        if (!enemy.isDead && !enemy.isCured) {
          const mult = getEnemyCureMultiplier(enemy);
          const chance = (this.cureChance || 0.06) * mult;
          if (chance > 0 && Math.random() < chance) {
            enemy.cure();
          }
        }
      }
    }
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
      this.load.image(`${key}_mount`, `assets/${key}_mount.png${ASSET_VER}`);
      for (const dir of DIRECTIONS) {
        this.load.image(`${key}_base_${dir}`, `assets/${key}_base_${dir}.png${ASSET_VER}`);
        this.load.image(`${key}_mount_${dir}`, `assets/${key}_mount_${dir}.png${ASSET_VER}`);
        for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
          this.load.image(`${key}_base_${level}_${dir}`, `assets/${key}_base_${level}_${dir}.png${ASSET_VER}`);
          this.load.image(`${key}_mount_${level}_${dir}`, `assets/${key}_mount_${level}_${dir}.png${ASSET_VER}`);
          this.load.image(`${key}_gun_${level}_${dir}`, `assets/${key}_gun_${level}_${dir}.png${ASSET_VER}`);
        }
      }
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        this.load.image(`${key}_base_${level}`, `assets/${key}_base_${level}.png${ASSET_VER}`);
        this.load.image(`${key}_mount_${level}`, `assets/${key}_mount_${level}.png${ASSET_VER}`);
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
      sliceSheet(this, `${key}_mount_sheet`, `${key}_mount`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        sliceSheet(this, `${key}_base_${level}_sheet`, `${key}_base_${level}`);
        sliceSheet(this, `${key}_mount_${level}_sheet`, `${key}_mount_${level}`);
        sliceSheet(this, `${key}_gun_${level}_sheet`, `${key}_gun_${level}`);
      }
    }
    sliceSheet(this, 'template_base_sheet', 'template_base');
    initProceduralWeaponTextures(this);

    this.background = this.add.rectangle(0, 0, 1, 1, 0x000000, 1).setOrigin(0, 0).setDepth(-1000);

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
    this.createBattlePass();
    this.createInventory();
    this.createTop();
    this.createShop();
    this.createTabs();
    this.createTowerDetailModal();

    if (this.input.keyboard) {
      this.input.keyboard.on('keydown-ESC', () => {
        if (this.towerDetailModal && this.towerDetailModal.visible) {
          this.closeTowerDetail();
        }
      });
    }

    this.selectTab('lobby');
    this.layout();
    this.scale.off('resize', this.layout, this);
    this.scale.on('resize', this.layout, this);

    // Закрываем заставку автоматически, как только игра загрузилась
    if (typeof window !== 'undefined') {
      if (window.dismissSplash) {
        window.dismissSplash();
      } else {
        window.__gameLoaded = true;
      }
    }
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));

    this.loadPlayerData();
  }

  createLobby() {
    this.lobbyPage = this.add.container(0, 0).setDepth(10);

    this.selectedDifficulty = localStorage.getItem('spore_td_difficulty') || 'medium';
    this.selectedMap = localStorage.getItem('spore_td_map') || 'lab';

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

    // Селектор карты
    this.mapBoxBg = this.add.graphics();
    this.mapPreviewGfx = this.add.graphics();
    this.mapLabel = this.add
      .text(0, 0, 'КАРТА', { fontFamily: UI_FONT, fontSize: '12px', color: '#8e9eb5', fontStyle: 'bold' })
      .setOrigin(0.5);
    this.mapPrevBtn = this.add
      .text(0, 0, '‹', {
        fontFamily: UI_FONT,
        fontSize: '26px',
        color: '#38bdf8',
        backgroundColor: '#1b2234',
        padding: { x: 12 * DPR, y: 6 * DPR },
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    roundTarget(this, this.mapPrevBtn, {
      color: 0x1b2234,
      radius: 12 * DPR,
      strokeColor: 0x2e3d5b,
      strokeWidth: 1.2 * DPR,
    });

    this.mapTitle = this.add
      .text(0, 0, '', { fontFamily: UI_FONT, fontSize: '18px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5);
    this.mapNextBtn = this.add
      .text(0, 0, '›', {
        fontFamily: UI_FONT,
        fontSize: '26px',
        color: '#38bdf8',
        backgroundColor: '#1b2234',
        padding: { x: 12 * DPR, y: 6 * DPR },
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    roundTarget(this, this.mapNextBtn, {
      color: 0x1b2234,
      radius: 12 * DPR,
      strokeColor: 0x2e3d5b,
      strokeWidth: 1.2 * DPR,
    });

    this.mapStatsText = this.add
      .text(0, 0, '', { fontFamily: UI_FONT, fontSize: '12px', color: '#38bdf8', fontStyle: 'bold' })
      .setOrigin(0.5);

    this.mapDesc = this.add
      .text(0, 0, '', { fontFamily: UI_FONT, fontSize: '12px', color: '#94a3b8', align: 'center' })
      .setOrigin(0.5);

    this.mapPrevBtn.on('pointerdown', (p, x, y, ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      this.cycleMap(-1);
    });
    this.mapNextBtn.on('pointerdown', (p, x, y, ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      this.cycleMap(1);
    });

    // Селектор сложности
    this.diffLabel = this.add
      .text(0, 0, 'РЕЖИМ СЛОЖНОСТИ', { fontFamily: UI_FONT, fontSize: '11px', color: '#707e94', fontStyle: 'bold' })
      .setOrigin(0.5);

    this.diffButtons = {};
    const diffKeys = ['easy', 'medium', 'hard'];
    diffKeys.forEach((k) => {
      const def = GAME_DIFFICULTIES[k];
      const btn = this.add
        .text(0, 0, def.name, {
          fontFamily: UI_FONT,
          fontSize: '13px',
          color: '#ffffff',
          backgroundColor: '#161a26',
          padding: { x: 12 * DPR, y: 7 * DPR },
          fontStyle: 'bold',
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      roundTarget(this, btn, {
        color: 0x161a26,
        alpha: 0.95,
        radius: 8 * DPR,
        strokeColor: 0x252d40,
        strokeWidth: 1 * DPR,
      });

      btn.on('pointerdown', (p, x, y, ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.selectDifficulty(k);
      });
      this.diffButtons[k] = btn;
    });

    this.diffDesc = this.add
      .text(0, 0, '', { fontFamily: UI_FONT, fontSize: '11px', color: '#8898aa', align: 'center' })
      .setOrigin(0.5);

    // Служебные скрытые текстовые объекты для обратной совместимости
    this.profileText = this.add.text(0, 0, '', { fontFamily: UI_FONT, fontSize: '1px' }).setVisible(false);
    this.bestText = this.add.text(0, 0, '', { fontFamily: UI_FONT, fontSize: '1px' }).setVisible(false);

    // Главная кнопка запуска игры
    this.playButton = this.add
      .text(0, 0, 'В БОЙ', {
        fontFamily: UI_FONT,
        fontSize: '24px',
        color: '#ffffff',
        backgroundColor: '#e63946',
        padding: { x: 42 * DPR, y: 13 * DPR },
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
      this.scene.start('GameScene', {
        difficulty: this.selectedDifficulty,
        map: this.selectedMap,
      });
    });
    this.playButton.on('pointerout', () => {
      this.playButton.setScale(1.0);
    });

    roundTarget(this, this.playButton, {
      color: 0xe63946,
      alpha: 1,
      radius: 13 * DPR,
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
      this.mapBoxBg,
      this.mapPreviewGfx,
      this.mapLabel,
      this.mapPrevBtn,
      this.mapTitle,
      this.mapNextBtn,
      this.mapStatsText,
      this.mapDesc,
      this.diffLabel,
      this.diffButtons.easy,
      this.diffButtons.medium,
      this.diffButtons.hard,
      this.diffDesc,
      this.profileText,
      this.bestText,
      this.playButton,
    ]);

    this.updateLobbyControls();
  }

  selectDifficulty(key) {
    if (!GAME_DIFFICULTIES[key]) return;
    this.selectedDifficulty = key;
    try {
      localStorage.setItem('spore_td_difficulty', key);
      localStorage.setItem('spore_difficulty', key);
    } catch (e) {}
    this.updateLobbyControls();
  }

  cycleMap(direction) {
    const keys = Object.keys(GAME_MAPS);
    let idx = keys.indexOf(this.selectedMap);
    if (idx < 0) idx = 0;
    idx = (idx + direction + keys.length) % keys.length;
    this.selectedMap = keys[idx];
    try {
      localStorage.setItem('spore_td_map', this.selectedMap);
      localStorage.setItem('spore_map', this.selectedMap);
    } catch (e) {}
    this.updateLobbyControls();
  }

  updateLobbyControls() {
    const mapDef = GAME_MAPS[this.selectedMap] || GAME_MAPS.lab;
    if (this.mapTitle) this.mapTitle.setText(mapDef.name);
    if (this.mapDesc) this.mapDesc.setText('').setVisible(false);

    const elevCount = (mapDef.elevations && mapDef.elevations.length) || 0;
    if (this.mapStatsText) {
      this.mapStatsText.setText(`Возвышенности: ${elevCount} · 35 волн`);
    }

    if (this.mapBoxBg && this.mapBoxW && this.mapBoxH) {
      this.mapBoxBg.clear();
      this.mapBoxBg.fillStyle(0x131722, 0.95);
      this.mapBoxBg.fillRoundedRect(this.mapBoxX, this.mapBoxY, this.mapBoxW, this.mapBoxH, 14 * DPR);
      this.mapBoxBg.lineStyle(1.6 * DPR, (mapDef.theme && mapDef.theme.accentColor) || 0x242d40, 1);
      this.mapBoxBg.strokeRoundedRect(this.mapBoxX, this.mapBoxY, this.mapBoxW, this.mapBoxH, 14 * DPR);

      const previewCy = this.mapBoxY + 86 * DPR;
      this.renderMapPreview(mapDef, this.mapBoxX + this.mapBoxW / 2, previewCy, this.mapBoxW * 0.72, 68 * DPR);
    }

    const diffDef = GAME_DIFFICULTIES[this.selectedDifficulty] || GAME_DIFFICULTIES.medium;
    if (this.diffDesc) this.diffDesc.setText('').setVisible(false);

    if (this.diffButtons) {
      for (const k in this.diffButtons) {
        const btn = this.diffButtons[k];
        const active = k === this.selectedDifficulty;
        const curDef = GAME_DIFFICULTIES[k];
        btn.setColor(active ? '#ffffff' : '#707e94');
        if (btn._roundItem) {
          btn._roundItem.color = active ? curDef.colorHex : 0x161a26;
          btn._roundItem.strokeColor = active ? 0xffffff : 0x252d40;
          btn._roundItem.strokeWidth = (active ? 1.5 : 1) * DPR;
        }
      }
    }
    updateRoundBgs(this);
  }

  renderMapPreview(mapDef, cx, cy, maxW, maxH) {
    if (!this.mapPreviewGfx || !mapDef) return;
    const gfx = this.mapPreviewGfx;
    gfx.clear();

    const theme = mapDef.theme || {
      cellColor: 0x161a24,
      roadColor: 0x475569,
      gridColor: 0x263044,
      accentColor: 0x38bdf8,
      elevationTop: 0x2b3954,
      elevationSide: 0x182234,
      elevationBorder: 0x4ea8de,
    };

    const tileW = Math.min(22 * DPR, (maxW * 0.8) / 10);
    const tileH = tileW * 0.52;

    const project = (gx, gy, elevationLift = 0) => {
      return {
        x: cx + (gx - gy) * (tileW * 0.5),
        y: cy + (gx + gy - 10) * (tileH * 0.5) - elevationLift,
      };
    };

    // Остров
    const topPt = project(0, 0);
    const rightPt = project(10, 0);
    const botPt = project(10, 10);
    const leftPt = project(0, 10);

    const depth = 8 * DPR;
    gfx.fillStyle(Phaser.Display.Color.IntegerToColor(theme.cellColor).darken(40).color, 0.9);
    gfx.beginPath();
    gfx.moveTo(leftPt.x, leftPt.y);
    gfx.lineTo(botPt.x, botPt.y);
    gfx.lineTo(botPt.x, botPt.y + depth);
    gfx.lineTo(leftPt.x, leftPt.y + depth);
    gfx.closePath();
    gfx.fillPath();

    gfx.fillStyle(Phaser.Display.Color.IntegerToColor(theme.cellColor).darken(55).color, 0.9);
    gfx.beginPath();
    gfx.moveTo(botPt.x, botPt.y);
    gfx.lineTo(rightPt.x, rightPt.y);
    gfx.lineTo(rightPt.x, rightPt.y + depth);
    gfx.lineTo(botPt.x, botPt.y + depth);
    gfx.closePath();
    gfx.fillPath();

    // Верхняя плоскость
    gfx.fillStyle(theme.cellColor, 0.95);
    gfx.beginPath();
    gfx.moveTo(topPt.x, topPt.y);
    gfx.lineTo(rightPt.x, rightPt.y);
    gfx.lineTo(botPt.x, botPt.y);
    gfx.lineTo(leftPt.x, leftPt.y);
    gfx.closePath();
    gfx.fillPath();

    gfx.lineStyle(1.2 * DPR, theme.gridColor, 0.8);
    gfx.strokePath();

    // Дорожка
    const wp = mapDef.waypoints || [];
    if (wp.length > 1) {
      gfx.lineStyle(5.5 * DPR, theme.roadColor, 0.95);
      gfx.beginPath();
      const p0 = project(wp[0].x, wp[0].y);
      gfx.moveTo(p0.x, p0.y);
      for (let i = 1; i < wp.length; i++) {
        const pt = project(wp[i].x, wp[i].y);
        gfx.lineTo(pt.x, pt.y);
      }
      gfx.strokePath();

      gfx.lineStyle(1.8 * DPR, theme.accentColor, 0.9);
      gfx.beginPath();
      gfx.moveTo(p0.x, p0.y);
      for (let i = 1; i < wp.length; i++) {
        const pt = project(wp[i].x, wp[i].y);
        gfx.lineTo(pt.x, pt.y);
      }
      gfx.strokePath();

      // Старт
      gfx.fillStyle(0x22c55e, 1);
      gfx.fillCircle(p0.x, p0.y, 3.5 * DPR);
      gfx.lineStyle(1 * DPR, 0xffffff, 1);
      gfx.strokeCircle(p0.x, p0.y, 3.5 * DPR);

      // База
      const pLast = project(wp[wp.length - 1].x, wp[wp.length - 1].y);
      gfx.fillStyle(0xef4444, 1);
      gfx.fillCircle(pLast.x, pLast.y, 3.8 * DPR);
      gfx.lineStyle(1 * DPR, 0xffffff, 1);
      gfx.strokeCircle(pLast.x, pLast.y, 3.8 * DPR);
    }

    // Возвышенности
    const elevations = mapDef.elevations || [];
    const lift = 6 * DPR;
    elevations.forEach((elev) => {
      const ex0 = elev.x;
      const ey0 = elev.y;
      const ex1 = elev.x + (elev.w || 2);
      const ey1 = elev.y + (elev.h || 2);

      const bTop = project(ex0, ey0);
      const bRight = project(ex1, ey0);
      const bBot = project(ex1, ey1);
      const bLeft = project(ex0, ey1);

      const tTop = project(ex0, ey0, lift);
      const tRight = project(ex1, ey0, lift);
      const tBot = project(ex1, ey1, lift);
      const tLeft = project(ex0, ey1, lift);

      // Левая боковая
      gfx.fillStyle(theme.elevationSide || 0x182234, 0.95);
      gfx.beginPath();
      gfx.moveTo(tLeft.x, tLeft.y);
      gfx.lineTo(tBot.x, tBot.y);
      gfx.lineTo(bBot.x, bBot.y);
      gfx.lineTo(bLeft.x, bLeft.y);
      gfx.closePath();
      gfx.fillPath();

      // Правая боковая
      gfx.fillStyle(Phaser.Display.Color.IntegerToColor(theme.elevationSide || 0x182234).darken(20).color, 0.95);
      gfx.beginPath();
      gfx.moveTo(tBot.x, tBot.y);
      gfx.lineTo(tRight.x, tRight.y);
      gfx.lineTo(bRight.x, bRight.y);
      gfx.lineTo(bBot.x, bBot.y);
      gfx.closePath();
      gfx.fillPath();

      // Верхняя грань
      gfx.fillStyle(theme.elevationTop || 0x2b3954, 0.98);
      gfx.beginPath();
      gfx.moveTo(tTop.x, tTop.y);
      gfx.lineTo(tRight.x, tRight.y);
      gfx.lineTo(tBot.x, tBot.y);
      gfx.lineTo(tLeft.x, tLeft.y);
      gfx.closePath();
      gfx.fillPath();

      gfx.lineStyle(1.4 * DPR, theme.elevationBorder || 0x4ea8de, 1);
      gfx.strokePath();

      const centerPt = project((ex0 + ex1) / 2, (ey0 + ey1) / 2, lift);
      gfx.fillStyle(theme.elevationBorder || 0x4ea8de, 1);
      gfx.fillCircle(centerPt.x, centerPt.y, 2.2 * DPR);
    });
  }

  createInventory() {
    this.inventoryPage = this.add.container(0, 0).setVisible(false).setDepth(10);

    this.inventoryTitle = this.add
      .text(0, 0, 'БОЕВОЙ НАБОР', {
        fontFamily: UI_FONT,
        fontSize: '22px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.inventorySubtitle = this.add
      .text(0, 0, '', {
        fontFamily: UI_FONT,
        fontSize: '13px',
        color: '#707e94',
      })
      .setOrigin(0.5);

    this.inventoryPage.add([this.inventoryTitle, this.inventorySubtitle]);
    this.inventoryRows = [];
    this.refreshInventoryUI();
  }

  toggleTowerInDeck(key) {
    let deck = getPlayerDeck();
    if (deck.includes(key)) {
      if (deck.length <= 1) {
        this.showToast('В боевом наборе должна остаться хотя бы 1 башня!');
        return;
      }
      deck = deck.filter((k) => k !== key);
      savePlayerDeck(deck);
      this.showToast(`Башня «${TOWER_TYPES[key].name}» убрана из боя (${deck.length}/${MAX_DECK_SLOTS})`);
    } else {
      if (deck.length >= MAX_DECK_SLOTS) {
        this.showToast('В бой можно взять максимум 5 башен!');
        return;
      }
      deck.push(key);
      savePlayerDeck(deck);
      this.showToast(`Башня «${TOWER_TYPES[key].name}» взята в бой (${deck.length}/${MAX_DECK_SLOTS})`);
    }
    this.refreshInventoryUI();
    if (this.towerDetailModal && this.towerDetailModal.visible && this.selectedTowerKey === key) {
      this.renderTowerDetail();
    }
    if (typeof this.layout === 'function') {
      this.layout();
    }
  }

  refreshInventoryUI() {
    if (!this.inventoryPage) return;
    if (this.inventoryRows) {
      this.inventoryRows.forEach((r) => r.destroy());
    }
    this.inventoryRows = [];

    const deck = getPlayerDeck();
    if (this.inventorySubtitle) {
      this.inventorySubtitle.setText(`Боевой набор: ${deck.length}/${MAX_DECK_SLOTS}`);
    }

    for (const key in TOWER_TYPES) {
      const type = TOWER_TYPES[key];
      const inDeck = deck.includes(key);
      const row = this.add.container(0, 0);

      const bg = this.add
        .rectangle(0, 0, 320, 76, 0x131722, 0.95)
        .setStrokeStyle(1.5 * DPR, inDeck ? 0x2ecc71 : 0x272f44, 1);

      const iconTile = this.add.rectangle(-120, 0, 52, 52, 0x1b2030, 0.9);
      roundTarget(this, iconTile, {
        kind: 'rect',
        color: 0x1b2030,
        alpha: 0.9,
        radius: 10,
        strokeColor: 0x2e384e,
        strokeWidth: 1,
      });

      const icon = this.add.container(-120, 0);
      const baseKey = this.getBaseTextureKey(key) || type.texture;
      if (baseKey) icon.add(this.add.image(0, 0, baseKey).setDisplaySize(44, 44));
      const weaponKey = this.getWeaponTextureKey(key, 1);
      if (weaponKey) icon.add(this.add.image(0, 0, weaponKey).setDisplaySize(44, 44));

      const name = this.add
        .text(-82, -13, type.name, {
          fontFamily: UI_FONT,
          fontSize: '16.5px',
          color: '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0, 0.5);
      const baseGunName = type.levels ? type.levels[0].name : '';
      const infoText = baseGunName
        ? `База: ${baseGunName} · Урон: ${type.damage} · Цена: ${type.cost}`
        : `Стоимость: ${type.cost} · Урон: ${type.damage || 1}`;
      const info = this.add
        .text(-82, 14, infoText, {
          fontFamily: UI_FONT,
          fontSize: '12px',
          color: '#8b98aa',
        })
        .setOrigin(0, 0.5);

      const deckBtn = this.add
        .text(118, 0, inDeck ? '✓ В БОЮ' : '+ ВЗЯТЬ', {
          fontFamily: UI_FONT,
          fontSize: '12px',
          color: inDeck ? '#4ade80' : '#94a3b8',
          backgroundColor: inDeck ? '#142b20' : '#1a2232',
          padding: { x: 8, y: 5 },
          fontStyle: 'bold',
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      roundTarget(this, deckBtn, {
        color: inDeck ? 0x142b20 : 0x1a2232,
        alpha: 0.95,
        radius: 7,
        strokeColor: inDeck ? 0x22c55e : 0x334155,
        strokeWidth: 1,
      });

      deckBtn.on('pointerdown', (pointer, lx, ly, event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.toggleTowerInDeck(key);
      });

      const hitZone = this.add.zone(-24, 0, 220, 76).setInteractive({ useHandCursor: true });

      row.add([bg, iconTile, icon, name, info, deckBtn, hitZone]);
      roundTarget(this, bg, {
        kind: 'rect',
        color: 0x131722,
        alpha: 0.95,
        radius: 14 * DPR,
        strokeColor: inDeck ? 0x2ecc71 : 0x252d40,
        strokeAlpha: 1,
        strokeWidth: (inDeck ? 1.8 : 1.2) * DPR,
      });

      hitZone.on('pointerdown', (pointer, localX, localY, event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.openTowerDetail(key);
      });

      this.inventoryPage.add(row);
      this.inventoryRows.push(row);
    }

    if (this.scale && this.scale.width && this.inventoryRows && this.inventoryRows.length) {
      const width = this.scale.width;
      const height = this.scale.height;
      const maxRowScale = width >= 600 ? 1.45 * DPR : 1.15 * DPR;
    const rowScale = Math.min((width * 0.90) / 320, maxRowScale);
      const rowStep = 78 * rowScale + 8 * DPR;
      const invStart = height * 0.16 + (39 * rowScale);
      this.inventoryRows.forEach((r, idx) => {
        r.setPosition(width / 2, invStart + idx * rowStep);
        r.setScale(rowScale);
      });
    }
  }

  createTowerDetailModal() {
    this.towerDetailModal = this.add.container(0, 0).setVisible(false).setDepth(60);

    // Затемнение фона
    this.detailBackdrop = this.add
      .rectangle(0, 0, 1, 1, 0x000000, 0.78)
      .setOrigin(0, 0)
      .setInteractive();
    this.detailBackdrop.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      // Закрытие по клику в пустое место отключено
    });

    // Графика плашек/карточки
    this.detailCardGfx = this.add.graphics();
    // Контейнер с текстами и кнопками
    this.detailElements = this.add.container(0, 0);

    this.towerDetailModal.add([this.detailBackdrop, this.detailCardGfx, this.detailElements]);
  }

  openTowerDetail(key) {
    this.selectedTowerKey = key;
    this.selectedDetailLevel = 1;
    this.towerDetailModal.setVisible(true);
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    if (telegram && telegram.BackButton) {
      try { telegram.BackButton.show(); } catch (e) {}
    }
    this.renderTowerDetail();
  }

  closeTowerDetail() {
    if (!this.towerDetailModal) return;
    this.towerDetailModal.setVisible(false);
    this.selectedTowerKey = null;
    const telegram = window.Telegram ? window.Telegram.WebApp : null;
    if (telegram && telegram.BackButton) {
      try { telegram.BackButton.hide(); } catch (e) {}
    }
  }

  renderTowerDetail() {
    const typeKey = this.selectedTowerKey;
    if (!typeKey || !TOWER_TYPES[typeKey]) return;
    const type = TOWER_TYPES[typeKey];
    const extra = TOWER_EXTRA_INFO[typeKey] || { role: '', traitDesc: '' };

    const { width, height } = this.scale;
    const isDesktop = width >= 600;

    // Адаптивный масштаб для ПК / десктопа, чтобы карточка и текст не были крошечными
    const maxAvailableW = Math.min(width * 0.94, isDesktop ? 580 * DPR : 440 * DPR);
    const maxAvailableH = Math.min(height * 0.90, isDesktop ? 760 * DPR : 620 * DPR);
    const scale = Math.max(1, Math.min(1.35, Math.min(maxAvailableW / (390 * DPR), maxAvailableH / (530 * DPR))));

    const pad = Math.round(16 * scale * DPR);
    const cardW = Math.round(Math.min(maxAvailableW, Math.max(350 * DPR, 420 * scale * DPR)));
    const traitW = cardW - pad * 2;

    const iconSize = Math.round(58 * scale * DPR);
    const btnW = cardW - pad * 2;
    const btnH = Math.round(38 * scale * DPR);
    const statTileH = Math.round(50 * scale * DPR);
    const traitH = Math.round(44 * scale * DPR);
    const levelRowH = Math.round(38 * scale * DPR);
    const levelRowGap = Math.round(5 * scale * DPR);

    const relBtnY = pad + iconSize + Math.round(14 * scale * DPR);
    const relStatsY = relBtnY + btnH + Math.round(10 * scale * DPR);
    const relTraitY = relStatsY + statTileH + Math.round(8 * scale * DPR);
    const relLevelsHeaderY = relTraitY + traitH + Math.round(12 * scale * DPR);
    const relLevelsStartY = relLevelsHeaderY + Math.round(18 * scale * DPR);
    const levelsCount = type.levels ? type.levels.length : 0;
    const totalContentH = relLevelsStartY + levelsCount * (levelRowH + levelRowGap) - levelRowGap + pad;

    const cardH = Math.round(totalContentH);
    const cardX = Math.round(width / 2 - cardW / 2);
    const cardY = Math.round(height / 2 - cardH / 2);

    this.detailBackdrop.setPosition(0, 0).setSize(width, height);
    this.detailElements.removeAll(true);

    const g = this.detailCardGfx;
    g.clear();

    // Внешняя карточка
    g.fillStyle(0x131722, 0.98);
    g.fillRoundedRect(cardX, cardY, cardW, cardH, 16 * scale * DPR);
    g.lineStyle(1.5 * scale * DPR, 0x252d40, 1);
    g.strokeRoundedRect(cardX, cardY, cardW, cardH, 16 * scale * DPR);

    const curLevel = Phaser.Math.Clamp(this.selectedDetailLevel || 1, 1, 5);
    const curLevelData = (type.levels && type.levels[curLevel - 1]) || null;
    const curWeaponName = curLevelData ? curLevelData.name : '';

    // Шапка: Иконка (показывает пушку текущего выбранного уровня)
    const iconX = cardX + pad;
    const iconY = cardY + pad;

    g.fillStyle(0x1b2030, 0.95);
    g.fillRoundedRect(iconX, iconY, iconSize, iconSize, 10 * scale * DPR);
    g.lineStyle(1.5 * scale * DPR, 0x3498db, 1);
    g.strokeRoundedRect(iconX, iconY, iconSize, iconSize, 10 * scale * DPR);

    const baseKey = this.getBaseTextureKey(typeKey) || type.texture;
    if (baseKey) {
      const baseImg = this.add.image(iconX + iconSize / 2, iconY + iconSize / 2, baseKey).setDisplaySize(iconSize - 10 * scale * DPR, iconSize - 10 * scale * DPR);
      const equippedSkin = getEquippedTowerSkin(typeKey);
      if (equippedSkin && equippedSkin.tint !== null && equippedSkin.tint !== undefined) {
        baseImg.setTint(equippedSkin.tint);
      }
      this.detailElements.add(baseImg);
    }
    const weaponKey = this.getWeaponTextureKey(typeKey, curLevel);
    if (weaponKey) {
      const gunImg = this.add.image(iconX + iconSize / 2, iconY + iconSize / 2, weaponKey).setDisplaySize(iconSize - 10 * scale * DPR, iconSize - 10 * scale * DPR);
      this.detailElements.add(gunImg);
    }

    // Название башни и текущее просматриваемое оружие
    const titleText = this.add.text(iconX + iconSize + 14 * scale * DPR, iconY + 3 * scale * DPR, type.name, {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(20 * scale * DPR)}px`,
      color: '#ffffff',
      fontStyle: 'bold',
    });

    const weaponTag = this.add.text(iconX + iconSize + 14 * scale * DPR, iconY + 28 * scale * DPR, `Оружие: ${curWeaponName} (${curLevel} ур.)`, {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(13 * scale * DPR)}px`,
      color: '#4ea8de',
      fontStyle: 'bold',
    });

    const subtitleText = this.add.text(iconX + iconSize + 14 * scale * DPR, iconY + 49 * scale * DPR, extra.role, {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(11.5 * scale * DPR)}px`,
      color: '#8b98aa',
      wordWrap: { width: cardW - iconSize - 40 * scale * DPR },
    });
    this.detailElements.add([titleText, weaponTag, subtitleText]);

    // Кнопка закрытия ✕
    const closeBtn = this.add.text(cardX + cardW - 22 * scale * DPR, cardY + 22 * scale * DPR, '✕', {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(22 * scale * DPR)}px`,
      color: '#8b98aa',
      padding: { x: 8 * DPR, y: 8 * DPR },
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

    closeBtn.on('pointerover', () => closeBtn.setColor('#ff4d5e'));
    closeBtn.on('pointerout', () => closeBtn.setColor('#8b98aa'));
    closeBtn.on('pointerdown', (p, x, y, ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      this.closeTowerDetail();
    });
    this.detailElements.add(closeBtn);

    // Слот-кнопка боевого набора (макс 5 башен в бой)
    const deck = getPlayerDeck();
    const inDeck = deck.includes(typeKey);
    const btnY = cardY + relBtnY;
    const btnX = cardX + pad;

    const deckBtnColor = inDeck ? '#4ade80' : '#ffffff';
    const deckBgColor = inDeck ? 0x142b20 : 0x1b2333;
    const deckStrokeColor = inDeck ? 0x22c55e : 0x334155;
    const deckBtnText = inDeck
      ? `✓ В БОЕВОМ НАБОРЕ (${deck.length}/${MAX_DECK_SLOTS})`
      : `+ ВЗЯТЬ В БОЙ (${deck.length}/${MAX_DECK_SLOTS})`;

    g.fillStyle(deckBgColor, 0.95);
    g.fillRoundedRect(btnX, btnY, btnW, btnH, 8 * scale * DPR);
    g.lineStyle(1.2 * scale * DPR, deckStrokeColor, 1);
    g.strokeRoundedRect(btnX, btnY, btnW, btnH, 8 * scale * DPR);

    const deckText = this.add.text(btnX + btnW / 2, btnY + btnH / 2, deckBtnText, {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(13 * scale * DPR)}px`,
      color: deckBtnColor,
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const deckZone = this.add.zone(btnX + btnW / 2, btnY + btnH / 2, btnW, btnH)
      .setInteractive({ useHandCursor: true });
    deckZone.on('pointerdown', (p, x, y, ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      this.toggleTowerInDeck(typeKey);
    });
    this.detailElements.add([deckText, deckZone]);

    // 4 быстрые характеристики (показывают статы выбранного уровня оружия)
    const statsY = cardY + relStatsY;
    const statGap = Math.round(6 * scale * DPR);
    const statTileW = (cardW - pad * 2 - 3 * statGap) / 4;

    const displayDmg = curLevelData
      ? (curLevelData.dualBarrels ? `${curLevelData.damage}x2` : `${curLevelData.damage}`)
      : `${type.damage}`;
    const displayFr = curLevelData
      ? (curLevelData.continuous ? 'Струя' : `${curLevelData.fireRate}/с`)
      : (type.fireRate ? `${type.fireRate}/с` : 'Струя');
    const displayRange = curLevelData ? `${curLevelData.range}` : `${type.range}`;
    const isTesla = typeKey === 'tesla';
    const isDisinfector = typeKey === 'disinfector';
    const fourthLabel = isTesla ? 'ЦЕПЕЙ' : (isDisinfector ? 'СПЛЕШ' : 'ТОЧНОСТЬ');
    const fourthVal = isTesla
      ? `${curLevelData ? curLevelData.chainCount : (type.chainCount || 2)}`
      : (isDisinfector
          ? `${(curLevelData ? curLevelData.splashRadius : (type.splashRadius || 1.2)).toFixed(1)}`
          : `${Math.round(((curLevelData && curLevelData.accuracy !== undefined) ? curLevelData.accuracy : (type.accuracy !== undefined ? type.accuracy : 1.0)) * 100)}%`);

    const statsList = [
      { label: 'УРОН', val: displayDmg, color: '#ff4d5e' },
      { label: 'ВЫСТР/С', val: displayFr, color: '#3498db' },
      { label: 'РАДИУС', val: displayRange, color: '#f1c40f' },
      { label: fourthLabel, val: fourthVal, color: '#2ecc71' },
    ];
    statsList.forEach((st, idx) => {
      const tileX = cardX + pad + idx * (statTileW + statGap);
      g.fillStyle(0x161b26, 0.95);
      g.fillRoundedRect(tileX, statsY, statTileW, statTileH, 7 * scale * DPR);
      g.lineStyle(1 * scale * DPR, 0x242d3e, 1);
      g.strokeRoundedRect(tileX, statsY, statTileW, statTileH, 7 * scale * DPR);

      const lbl = this.add.text(tileX + statTileW / 2, statsY + 13 * scale * DPR, st.label, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(11 * scale * DPR)}px`,
        color: '#707e94',
        fontStyle: 'bold',
      }).setOrigin(0.5);

      const val = this.add.text(tileX + statTileW / 2, statsY + 34 * scale * DPR, st.val, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(17 * scale * DPR)}px`,
        color: st.color,
        fontStyle: 'bold',
      }).setOrigin(0.5);

      this.detailElements.add([lbl, val]);
    });

    // Особенность башни
    const traitY = cardY + relTraitY;
    g.fillStyle(0x151b27, 0.95);
    g.fillRoundedRect(cardX + pad, traitY, traitW, traitH, 7 * scale * DPR);
    g.lineStyle(1 * scale * DPR, 0x273247, 1);
    g.strokeRoundedRect(cardX + pad, traitY, traitW, traitH, 7 * scale * DPR);

    const traitText = this.add.text(cardX + pad + 10 * scale * DPR, traitY + traitH / 2, extra.traitDesc, {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(12 * scale * DPR)}px`,
      color: '#9ab1cc',
      wordWrap: { width: traitW - 20 * scale * DPR },
      lineSpacing: 2 * scale * DPR,
    }).setOrigin(0, 0.5);
    this.detailElements.add(traitText);

    // Ветка прокачки оружия (1-5 уровни)
    const levelsHeaderY = cardY + relLevelsHeaderY;
    const headerTitle = this.add.text(cardX + pad, levelsHeaderY, 'УРОВНИ ОРУЖИЯ (1-5)', {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(12.5 * scale * DPR)}px`,
      color: '#4ea8de',
      fontStyle: 'bold',
    });
    this.detailElements.add(headerTitle);

    const levelsStartY = cardY + relLevelsStartY;
    for (let lv = 0; lv < levelsCount; lv++) {
      const levelData = type.levels[lv];
      const rowY = levelsStartY + lv * (levelRowH + levelRowGap);
      const isSelected = curLevel === (lv + 1);

      if (isSelected) {
        g.fillStyle(0x1d273a, 0.98);
        g.fillRoundedRect(cardX + pad, rowY, traitW, levelRowH, 7 * scale * DPR);
        g.lineStyle(1.5 * scale * DPR, 0x4ea8de, 1);
        g.strokeRoundedRect(cardX + pad, rowY, traitW, levelRowH, 7 * scale * DPR);
      } else {
        g.fillStyle(0x161c28, 0.95);
        g.fillRoundedRect(cardX + pad, rowY, traitW, levelRowH, 6 * scale * DPR);
        g.lineStyle(1 * scale * DPR, 0x242d40, 1);
        g.strokeRoundedRect(cardX + pad, rowY, traitW, levelRowH, 6 * scale * DPR);
      }

      // Иконка оружия текущего уровня
      const miniIconSize = Math.round(28 * scale * DPR);
      const miniIconX = cardX + pad + Math.round(6 * scale * DPR);
      const miniIconY = rowY + (levelRowH - miniIconSize) / 2;

      g.fillStyle(0x121622, 0.95);
      g.fillRoundedRect(miniIconX, miniIconY, miniIconSize, miniIconSize, 5 * scale * DPR);
      g.lineStyle(1 * scale * DPR, isSelected ? 0x4ea8de : 0x283348, 1);
      g.strokeRoundedRect(miniIconX, miniIconY, miniIconSize, miniIconSize, 5 * scale * DPR);

      const lvlWpnKey = this.getWeaponTextureKey(typeKey, lv + 1);
      if (lvlWpnKey) {
        const miniImg = this.add.image(miniIconX + miniIconSize / 2, miniIconY + miniIconSize / 2, lvlWpnKey)
          .setDisplaySize(miniIconSize - 4 * scale * DPR, miniIconSize - 4 * scale * DPR);
        this.detailElements.add(miniImg);
      }

      const badgeX = miniIconX + miniIconSize + Math.round(8 * scale * DPR);
      const badge = this.add.text(badgeX, rowY + levelRowH / 2, `[${lv + 1}]`, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(13 * scale * DPR)}px`,
        color: isSelected ? '#4ea8de' : '#e63946',
        fontStyle: 'bold',
      }).setOrigin(0, 0.5);

      const wNameX = badgeX + Math.round(24 * scale * DPR);
      const wName = this.add.text(wNameX, rowY + levelRowH / 2, levelData.name, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(14 * scale * DPR)}px`,
        color: isSelected ? '#ffffff' : '#d2dced',
        fontStyle: 'bold',
      }).setOrigin(0, 0.5);

      let statLine = '';
      if (typeKey === 'disinfector') {
        if (levelData.continuous) {
          statLine = `Урон: ${levelData.damage}/с · Струя · +${levelData.upgradeCost} 💰`;
        } else {
          statLine = `Урон: ${levelData.damage} · ${levelData.fireRate}/с · ${lv === 0 ? 'Базовый' : `+${levelData.upgradeCost} 💰`}`;
        }
      } else if (typeKey === 'tesla') {
        statLine = `Урон: ${levelData.damage} · ${levelData.chainCount || 2} ц. · ${lv === 0 ? 'Базовый' : `+${levelData.upgradeCost} 💰`}`;
      } else if (typeKey === 'minigun') {
        const dmgStr = levelData.dualBarrels ? `${levelData.damage}x2` : `${levelData.damage}`;
        statLine = `Урон: ${dmgStr} · ${levelData.fireRate}/с · ${lv === 0 ? 'Базовый' : `+${levelData.upgradeCost} 💰`}`;
      } else {
        statLine = `Урон: ${levelData.damage} · ${levelData.fireRate}/с · ${lv === 0 ? 'Базовый' : `+${levelData.upgradeCost} 💰`}`;
      }

      const wStat = this.add.text(cardX + pad + traitW - Math.round(10 * scale * DPR), rowY + levelRowH / 2, statLine, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(12.5 * scale * DPR)}px`,
        color: isSelected ? '#ffffff' : '#8b98aa',
      }).setOrigin(1, 0.5);

      // Интерактивная зона на всю строку уровня для переключения визуала оружия
      const rowZone = this.add.zone(cardX + pad + traitW / 2, rowY + levelRowH / 2, traitW, levelRowH)
        .setInteractive({ useHandCursor: true });
      rowZone.on('pointerdown', (p, x, y, ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.selectedDetailLevel = lv + 1;
        this.renderTowerDetail();
      });

      this.detailElements.add([badge, wName, wStat, rowZone]);
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

    roundTarget(this, this.statsText, {
      color: 0x141824,
      alpha: 0.95,
      radius: 10 * DPR,
      strokeColor: 0x242c3e,
      strokeWidth: 1 * DPR,
    });

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

  showToast(msg) {
    if (!this.toastContainer) {
      this.toastContainer = this.add.container(0, 0).setDepth(200);
      this.toastBg = this.add.rectangle(0, 0, 10, 10, 0x141a26, 0.96);
      roundTarget(this, this.toastBg, {
        kind: 'rect',
        color: 0x141a26,
        alpha: 0.96,
        radius: 10 * DPR,
        strokeColor: 0xe63946,
        strokeWidth: 1.5 * DPR,
      });
      this.toastText = this.add
        .text(0, 0, '', {
          fontFamily: UI_FONT,
          fontSize: `${Math.round(13 * DPR)}px`,
          color: '#ffffff',
          fontStyle: 'bold',
          align: 'center',
        })
        .setOrigin(0.5);
      this.toastContainer.add([this.toastBg, this.toastText]);
    }
    const width = this.scale.width;
    const height = this.scale.height;
    this.toastText.setText(msg);
    const padX = 28 * DPR;
    const padY = 16 * DPR;
    const w = Math.min(width * 0.9, this.toastText.width + padX);
    const h = this.toastText.height + padY;
    this.toastBg.setSize(w, h);
    this.toastContainer.setPosition(width / 2, height * 0.84);
    this.toastContainer.setAlpha(0).setVisible(true);

    if (this.toastTween) this.toastTween.stop();
    this.toastTween = this.tweens.add({
      targets: this.toastContainer,
      alpha: 1,
      y: height * 0.81,
      duration: 180,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        this.toastTween = this.tweens.add({
          targets: this.toastContainer,
          alpha: 0,
          y: height * 0.79,
          delay: 1500,
          duration: 250,
          ease: 'Cubic.easeIn',
          onComplete: () => this.toastContainer.setVisible(false),
        });
      },
    });
    updateRoundBgs(this);
  }

  createBattlePass() {
    this.passPage = this.add.container(0, 0).setVisible(false).setDepth(10);

    // Заголовок: ЗАДАНИЯ И КВЕСТЫ
    this.passTitle = this.add
      .text(0, 0, 'БОЕВЫЕ ЗАДАНИЯ', {
        fontFamily: UI_FONT,
        fontSize: '24px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.passSubtitle = this.add
      .text(0, 0, '', {
        fontFamily: UI_FONT,
        fontSize: '15px',
        color: '#38bdf8',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    // Баннер-заглушка: БОЕВОЙ ПАСС ВРЕМЕННО ЗАКРЫТ (СКОРО)
    this.passLockBanner = this.add.container(0, 0);
    this.passLockBg = this.add.rectangle(0, 0, 320, 52, 0x131722, 0.95);
    roundTarget(this, this.passLockBg, {
      kind: 'rect',
      color: 0x131722,
      alpha: 0.95,
      radius: 10 * DPR,
      strokeColor: 0xe63946,
      strokeWidth: 1.2 * DPR,
    });
    this.passLockIcon = this.add.text(-120, 0, '🔒', { fontSize: '20px' }).setOrigin(0.5);
    this.passLockTitle = this.add
      .text(-96, 0, 'БОЕВОЙ ПАСС · ЗАКРЫТ (СКОРО)', {
        fontFamily: UI_FONT,
        fontSize: '13px',
        color: '#ff4d5e',
        fontStyle: 'bold',
      })
      .setOrigin(0, 0.5);
    this.passLockSub = this.add
      .text(-96, 10, '', {
        fontFamily: UI_FONT,
        fontSize: '11.5px',
        color: '#94a3b8',
      })
      .setOrigin(0, 0.5);
    this.passLockBanner.add([this.passLockBg, this.passLockIcon, this.passLockTitle, this.passLockSub]);

    this.passCardGfx = this.add.graphics();
    this.passMaskGfx = this.make.graphics();
    this.passMask = this.passMaskGfx.createGeometryMask();

    this.passListContainer = this.add.container(0, 0);
    this.passListContainer.setMask(this.passMask);

    this.passScrollbarGfx = this.add.graphics();
    this.passScrollZone = this.add.zone(0, 0, 10, 10).setOrigin(0, 0);
    this.passScrollZone.setInteractive({ useHandCursor: true });

    this.questRows = [];

    this.passPage.add([
      this.passTitle,
      this.passSubtitle,
      this.passLockBanner,
      this.passCardGfx,
      this.passListContainer,
      this.passScrollbarGfx,
      this.passScrollZone,
    ]);

    this.refreshQuestsUI();
    this.initPassScroll();
  }

  refreshQuestsUI() {
    if (!this.passListContainer) return;
    this.passListContainer.removeAll(true);
    this.questRows = [];

    const quests = getPlayerQuests();
    for (let i = 0; i < quests.length; i++) {
      const q = quests[i];
      const row = this.add.container(0, 0);
      const isDone = (q.progress || 0) >= q.target;
      const isClaimed = Boolean(q.claimed);

      const rowBg = this.add.rectangle(0, 0, 320, 84, 0x131722, 0.95);
      roundTarget(this, rowBg, {
        kind: 'rect',
        color: isDone ? 0x142322 : 0x111622,
        alpha: 0.95,
        radius: 10,
        strokeColor: isDone ? 0x22c55e : 0x242e42,
        strokeWidth: 1,
      });

      const icon = this.add.text(-134, 0, q.icon || '⚔️', { fontSize: '24px' }).setOrigin(0.5);

      const title = this.add
        .text(-112, -22, q.title, {
          fontFamily: UI_FONT,
          fontSize: '14.5px',
          color: '#ffffff',
          fontStyle: 'bold',
          wordWrap: { width: 165 },
        })
        .setOrigin(0, 0.5);

      const desc = this.add
        .text(-112, -3, q.desc, {
          fontFamily: UI_FONT,
          fontSize: '11px',
          color: '#8e9eb5',
          wordWrap: { width: 165 },
          lineSpacing: 1.5,
        })
        .setOrigin(0, 0.5);

      const progressVal = Math.min(q.target, q.progress || 0);
      const progText = this.add
        .text(-112, 22, `Прогресс: ${progressVal} / ${q.target}`, {
          fontFamily: UI_FONT,
          fontSize: '11.5px',
          color: isDone ? '#4ade80' : '#38bdf8',
          fontStyle: 'bold',
        })
        .setOrigin(0, 0.5);

      // Кнопка награды
      const btnText = isClaimed ? 'ЗАБРАНО' : (isDone ? `+${q.reward} 🟡` : `${q.reward} 🟡`);
      const btnColor = isClaimed ? '#64748b' : (isDone ? '#ffffff' : '#f1c40f');
      const btnBgColor = isDone ? 0x22c55e : 0x1a2232;
      const btnStroke = isDone ? 0x4ade80 : 0x334155;

      const actionBtn = this.add
        .text(120, 0, btnText, {
          fontFamily: UI_FONT,
          fontSize: '12px',
          color: btnColor,
          backgroundColor: '#1a2232',
          padding: { x: 8, y: 5 },
          fontStyle: 'bold',
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: isDone && !isClaimed });

      roundTarget(this, actionBtn, {
        color: btnBgColor,
        alpha: 0.95,
        radius: 7,
        strokeColor: btnStroke,
        strokeWidth: 1,
      });

      actionBtn.on('pointerdown', (pointer, lx, ly, event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (isClaimed) {
          this.showToast('Награда уже получена!');
          return;
        }
        if (!isDone) {
          this.showToast(`Выполните условие: ${q.desc}`);
          return;
        }
        const rewarded = claimQuestReward(q.id);
        if (rewarded > 0) {
          this.showToast(`Получено +${rewarded} 🟡 за задание «${q.title}»!`);
          this.refreshProfile();
          this.refreshQuestsUI();
        }
      });

      row.add([rowBg, icon, title, desc, progText, actionBtn]);
      this.questRows.push(row);
      this.passListContainer.add(row);
    }

    // Сразу позиционируем строки заданий внутри контейнера списка
    const w = this.scale ? this.scale.width : 360;
    const cardW = this.passCardW || Math.min(w * 0.94, 550 * DPR);
    const qScale = Math.min((cardW * 0.94) / 320, 1.15 * DPR);
    const qStep = 86 * qScale + 10 * DPR;
    this.questRows.forEach((r, idx) => {
      r.setPosition(w / 2, idx * qStep + 44 * qScale);
      r.setScale(qScale);
    });
    this.passContentH = this.questRows.length * qStep + 16 * DPR;
    this.passMinScrollOffset = Math.min(0, (this.passVisibleH || 300) - this.passContentH);
    this.applyPassScroll(this.passScrollOffset || 0);

    updateRoundBgs(this);
  }

  refreshBattlePassUI() {
    this.refreshQuestsUI();
  }


  initPassScroll() {
    this.passScrollOffset = 0;
    this.passMinScrollOffset = 0;
    let isDragging = false;
    let startY = 0;
    let startOffset = 0;

    this.passScrollZone.on('pointerdown', (pointer) => {
      if (this.currentTab !== 'pass') return;
      isDragging = true;
      startY = pointer.y;
      startOffset = this.passScrollOffset;
    });

    this.input.on('pointermove', (pointer) => {
      if (!isDragging || this.currentTab !== 'pass') return;
      const dy = pointer.y - startY;
      this.applyPassScroll(startOffset + dy);
    });

    const stopDrag = () => {
      isDragging = false;
    };
    this.input.on('pointerup', stopDrag);
    this.input.on('pointerupoutside', stopDrag);

    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      if (this.currentTab !== 'pass') return;
      this.applyPassScroll(this.passScrollOffset - deltaY * 0.4);
    });
  }

  applyPassScroll(offset) {
    const minOffset = this.passMinScrollOffset || 0;
    const maxOffset = 0;
    this.passScrollOffset = Phaser.Math.Clamp(offset, minOffset, maxOffset);
    if (this.passListContainer) {
      this.passListContainer.y = (this.passListBaseY || 0) + this.passScrollOffset;
    }
    this.drawPassScrollbar();
  }

  drawPassScrollbar() {
    if (!this.passScrollbarGfx) return;
    this.passScrollbarGfx.clear();
    const totalH = this.passContentH || 0;
    const viewH = this.passVisibleH || 0;
    if (totalH <= viewH || viewH <= 0) return;

    const scrollbarX = this.passCardX + this.passCardW - 7 * DPR;
    const trackY = this.passCardInnerTop;
    const trackH = viewH;

    const thumbH = Math.max(22 * DPR, (viewH / totalH) * trackH);
    const scrollProgress = (-this.passScrollOffset) / (totalH - viewH);
    const thumbY = trackY + scrollProgress * (trackH - thumbH);

    this.passScrollbarGfx.fillStyle(0x354258, 0.85);
    this.passScrollbarGfx.fillRoundedRect(scrollbarX, thumbY, 3 * DPR, thumbH, 1.5 * DPR);
  }

  createShop() {
    this.shopPage = this.add.container(0, 0).setVisible(false).setDepth(10);

    this.shopTitle = this.add
      .text(0, 0, 'МАГАЗИН И СНАБЖЕНИЕ', {
        fontFamily: UI_FONT,
        fontSize: '24px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.shopSubtitle = this.add
      .text(0, 0, '', {
        fontFamily: UI_FONT,
        fontSize: '15px',
        color: '#707e94',
      })
      .setOrigin(0.5);

    this.shopCardGfx = this.add.graphics();
    this.shopMaskGfx = this.make.graphics();
    this.shopMask = this.shopMaskGfx.createGeometryMask();

    this.shopListContainer = this.add.container(0, 0);
    this.shopListContainer.setMask(this.shopMask);

    this.shopScrollbarGfx = this.add.graphics();
    this.shopScrollZone = this.add.zone(0, 0, 10, 10).setOrigin(0, 0);
    this.shopScrollZone.setInteractive({ useHandCursor: true });

    this.shopRows = [];

    // Раздел 1: Поддержка & Донат (СТРОГО "Скоро")
    const sec1Title = this.add
      .text(0, 0, '─── НАБОРЫ ЗОЛОТА ───', {
        fontFamily: UI_FONT,
        fontSize: '16px',
        color: '#ff6b7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.shopRows.push({ item: sec1Title, isHeader: true });
    this.shopListContainer.add(sec1Title);

    const donationPacks = [
      { name: 'Малый Паёк', gold: '500 🟡 Золота', price: '50 ⭐ (99 ₽)', desc: 'Стартовая помощь лаборатории' },
      { name: 'Набор Снабжения', gold: '1500 🟡 + Бейдж', price: '150 ⭐ (299 ₽)', desc: 'Официальный спонсор обороны' },
      { name: 'Боевой Арсенал', gold: '4000 🟡 + Баннер', price: '350 ⭐ (699 ₽)', desc: 'Инженерный резерв комплекса' },
      { name: 'Спонсор Лаборатории', gold: '10000 🟡 + Tester', price: '900 ⭐ (1490 ₽)', desc: 'Генеральная поддержка проекта' },
    ];

    for (const pack of donationPacks) {
      const row = this.add.container(0, 0);
      const bg = this.add.rectangle(0, 0, 320, 68, 0x131722, 0.95);
      roundTarget(this, bg, {
        kind: 'rect',
        color: 0x131722,
        alpha: 0.95,
        radius: 10 * DPR,
        strokeColor: 0x272f44,
        strokeWidth: 1 * DPR,
      });

      const title = this.add
        .text(-142, -14, pack.name, {
          fontFamily: UI_FONT,
          fontSize: '14.5px',
          color: '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0, 0.5);

      const sub = this.add
        .text(-142, 14, `${pack.gold} · ${pack.price}`, {
          fontFamily: UI_FONT,
          fontSize: '12px',
          color: '#94a3b8',
          wordWrap: { width: 195 },
        })
        .setOrigin(0, 0.5);

      // Кнопка доната СТРОГО "Скоро"
      const buyBtn = this.add
        .text(120, 0, 'Скоро', {
          fontFamily: UI_FONT,
          fontSize: '12px',
          color: '#94a3b8',
          backgroundColor: '#1e2433',
          padding: { x: 10, y: 5 },
          fontStyle: 'bold',
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      roundTarget(this, buyBtn, {
        color: 0x1a2130,
        alpha: 0.95,
        radius: 7,
        strokeColor: 0x334155,
        strokeWidth: 1,
      });

      buyBtn.on('pointerdown', (pointer, lx, ly, event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.showToast('Донат и покупка наборов будут доступны в следующем обновлении!');
      });

      row.add([bg, title, sub, buyBtn]);
      this.shopRows.push({ item: row, isHeader: false });
      this.shopListContainer.add(row);
    }

    // Раздел 2: Тактические ящики (СТРОГО "Скоро")
    const sec2Title = this.add
      .text(0, 0, '─── ТАКТИЧЕСКИЕ ЯЩИКИ ───', {
        fontFamily: UI_FONT,
        fontSize: '16px',
        color: '#ff6b7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.shopRows.push({ item: sec2Title, isHeader: true });
    this.shopListContainer.add(sec2Title);

    const crates = [
      {
        name: 'Обычный Ящик',
        tier: 'common',
        desc: 'Базовые компоненты турелей и тактические модули',
        colorHex: 0x94a3b8,
        glowHex: 0x64748b,
      },
      {
        name: 'Редкий Ящик',
        tier: 'rare',
        desc: 'Защитные и тактические модули «Спецназ» и «Крио»',
        colorHex: 0x38bdf8,
        glowHex: 0x0284c7,
      },
      {
        name: 'Легендарный Ящик',
        tier: 'legendary',
        desc: 'Эксклюзивные модули усиления «Омега-Прайм»',
        colorHex: 0xf59e0b,
        glowHex: 0xd97706,
      },
    ];

    for (const crate of crates) {
      const row = this.add.container(0, 0);
      const bg = this.add.rectangle(0, 0, 320, 80, 0x121620, 0.95);
      roundTarget(this, bg, {
        kind: 'rect',
        color: 0x121620,
        alpha: 0.95,
        radius: 10,
        strokeColor: crate.glowHex,
        strokeWidth: 1,
      });

      // Отрисованный кодом стилизованный компактный 3D-сундук
      const chestGfx = this.add.graphics();
      chestGfx.setPosition(-132, 0);

      // Свечение сзади ящика
      chestGfx.fillStyle(crate.glowHex, 0.25);
      chestGfx.fillCircle(0, 0, 18);

      // Корпус сундука
      chestGfx.fillStyle(0x182030, 1);
      chestGfx.fillRoundedRect(-14, -10, 28, 20, 4);
      chestGfx.lineStyle(1.5, crate.colorHex, 1);
      chestGfx.strokeRoundedRect(-14, -10, 28, 20, 4);

      // Крышка сундука
      chestGfx.fillStyle(crate.colorHex, 0.9);
      chestGfx.fillRoundedRect(-15, -13, 30, 7, 2.5);

      // Замок сундука
      chestGfx.fillStyle(0xffffff, 0.95);
      chestGfx.fillCircle(0, -2, 2.5);

      const title = this.add
        .text(-108, -16, crate.name, {
          fontFamily: UI_FONT,
          fontSize: '14.5px',
          color: '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0, 0.5);

      const sub = this.add
        .text(-108, 0, crate.desc, {
          fontFamily: UI_FONT,
          fontSize: '11px',
          color: '#8492a6',
          wordWrap: { width: 175 },
          lineSpacing: 1.5,
        })
        .setOrigin(0, 0);

      // КНОПКА СТРОГО "Скоро"
      const soonBtn = this.add
        .text(120, 0, 'Скоро', {
          fontFamily: UI_FONT,
          fontSize: '12px',
          color: '#94a3b8',
          backgroundColor: '#1e2433',
          padding: { x: 10, y: 5 },
          fontStyle: 'bold',
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      roundTarget(this, soonBtn, {
        color: 0x1a2130,
        alpha: 0.95,
        radius: 7,
        strokeColor: 0x334155,
        strokeWidth: 1,
      });

      soonBtn.on('pointerdown', (pointer, lx, ly, event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.showToast(`${crate.name} появится в следующем обновлении!`);
      });

      row.add([bg, chestGfx, title, sub, soonBtn]);
      this.shopRows.push({ item: row, isHeader: false });
      this.shopListContainer.add(row);
    }

    this.shopPage.add([
      this.shopTitle,
      this.shopSubtitle,
      this.shopCardGfx,
      this.shopListContainer,
      this.shopScrollbarGfx,
      this.shopScrollZone,
    ]);

    this.initShopScroll();
  }

  initShopScroll() {
    this.shopScrollOffset = 0;
    this.shopMinScrollOffset = 0;
    let isDragging = false;
    let startY = 0;
    let startOffset = 0;

    this.shopScrollZone.on('pointerdown', (pointer) => {
      if (this.currentTab !== 'shop') return;
      isDragging = true;
      startY = pointer.y;
      startOffset = this.shopScrollOffset;
    });

    this.input.on('pointermove', (pointer) => {
      if (!isDragging || this.currentTab !== 'shop') return;
      const dy = pointer.y - startY;
      this.applyShopScroll(startOffset + dy);
    });

    const stopDrag = () => {
      isDragging = false;
    };
    this.input.on('pointerup', stopDrag);
    this.input.on('pointerupoutside', stopDrag);

    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      if (this.currentTab !== 'shop') return;
      this.applyShopScroll(this.shopScrollOffset - deltaY * 0.4);
    });
  }

  applyShopScroll(offset) {
    const minOffset = this.shopMinScrollOffset || 0;
    const maxOffset = 0;
    this.shopScrollOffset = Phaser.Math.Clamp(offset, minOffset, maxOffset);
    if (this.shopListContainer) {
      this.shopListContainer.y = (this.shopListBaseY || 0) + this.shopScrollOffset;
    }
    this.drawShopScrollbar();
  }

  drawShopScrollbar() {
    if (!this.shopScrollbarGfx) return;
    this.shopScrollbarGfx.clear();
    const totalH = this.shopContentH || 0;
    const viewH = this.shopVisibleH || 0;
    if (totalH <= viewH || viewH <= 0) return;

    const scrollbarX = this.shopCardX + this.shopCardW - 7 * DPR;
    const trackY = this.shopCardInnerTop;
    const trackH = viewH;

    const thumbH = Math.max(22 * DPR, (viewH / totalH) * trackH);
    const scrollProgress = (-this.shopScrollOffset) / (totalH - viewH);
    const thumbY = trackY + scrollProgress * (trackH - thumbH);

    this.shopScrollbarGfx.fillStyle(0x354258, 0.85);
    this.shopScrollbarGfx.fillRoundedRect(scrollbarX, thumbY, 3 * DPR, thumbH, 1.5 * DPR);
  }

  createTabs() {
    this.tabBar = this.add.container(0, 0).setDepth(10);
    this.tabInventory = this.makeTab('Инвентарь', 'inventory');
    this.tabLobby = this.makeTab('Меню', 'lobby');
    this.tabPass = this.makeTab('Пасс', 'pass');
    this.tabTop = this.makeTab('Топ', 'top');
    this.tabShop = this.makeTab('Магазин', 'shop');
    this.tabBar.add([this.tabInventory, this.tabLobby, this.tabPass, this.tabTop, this.tabShop]);
  }

  makeTab(label, key) {
    const tab = this.add
      .text(0, 0, label, {
        fontFamily: UI_FONT,
        fontSize: '13px',
        color: '#707e94',
        backgroundColor: '#161a26',
        padding: { x: 8 * DPR, y: 7 * DPR },
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
      radius: 9 * DPR,
      strokeColor: 0x252d40,
      strokeAlpha: 1,
      strokeWidth: 1 * DPR,
    });
    return tab;
  }

  selectTab(key) {
    this.currentTab = key;
    if (this.towerDetailModal && this.towerDetailModal.visible && key !== 'inventory') {
      this.closeTowerDetail();
    }
    if (this.lobbyPage) this.lobbyPage.setVisible(key === 'lobby');
    if (this.passPage) this.passPage.setVisible(key === 'pass');
    if (this.inventoryPage) this.inventoryPage.setVisible(key === 'inventory');
    if (this.topPage) this.topPage.setVisible(key === 'top');
    if (this.shopPage) this.shopPage.setVisible(key === 'shop');

    if (this.topScrollZone && this.topScrollZone.input) {
      this.topScrollZone.input.enabled = (key === 'top');
    }
    if (this.passScrollZone && this.passScrollZone.input) {
      this.passScrollZone.input.enabled = (key === 'pass');
    }
    if (this.shopScrollZone && this.shopScrollZone.input) {
      this.shopScrollZone.input.enabled = (key === 'shop');
    }

    if (key === 'pass') {
      this.refreshBattlePassUI();
    }

    const isLobby = key === 'lobby';
    if (this.title) this.title.setVisible(isLobby);

    const tabs = [this.tabInventory, this.tabLobby, this.tabPass, this.tabTop, this.tabShop];
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

    // 1. Заголовок лобби
    if (this.title) {
      this.title.setPosition(width / 2, height * 0.075);
      this.title.setStyle({ fontSize: `${Math.min(30 * DPR, Math.max(22 * DPR, Math.round(size * 0.056)))}px` });
    }

    // 2. Карточка профиля игрока (чёткая, крупная, аккуратная)
    const cardWidth = Math.min(width * 0.92, 480 * DPR);
    const cardHeight = Math.round(96 * DPR);
    const cardTop = height * 0.115;
    const cardX = width / 2 - cardWidth / 2;

    if (this.cardBg) {
      this.cardBg.clear();
      this.cardBg.fillStyle(0x131722, 0.95);
      this.cardBg.fillRoundedRect(cardX, cardTop, cardWidth, cardHeight, 14 * DPR);
      this.cardBg.lineStyle(1.5 * DPR, 0x242d40, 1);
      this.cardBg.strokeRoundedRect(cardX, cardTop, cardWidth, cardHeight, 14 * DPR);
    }

    const nickSize = `${Math.round(Math.min(22 * DPR, Math.max(17 * DPR, size * 0.040)))}px`;
    const labelSize = `${Math.round(Math.min(14 * DPR, Math.max(12 * DPR, size * 0.028)))}px`;
    const valSize = `${Math.round(Math.min(26 * DPR, Math.max(22 * DPR, size * 0.048)))}px`;

    const nickY = cardTop + 20 * DPR;
    const dividerY = cardTop + 38 * DPR;
    const statLabelY = cardTop + 54 * DPR;
    const statValY = cardTop + 76 * DPR;

    if (this.playerNick) {
      this.playerNick.setPosition(width / 2, nickY);
      this.playerNick.setStyle({ fontSize: nickSize });
    }

    if (this.cardDivider) {
      this.cardDivider.clear();
      // Горизонтальный разделитель под ником
      this.cardDivider.lineStyle(1 * DPR, 0x1f2738, 0.8);
      this.cardDivider.lineBetween(cardX + 16 * DPR, dividerY, cardX + cardWidth - 16 * DPR, dividerY);
      // Вертикальные разделители колонок
      const colStep = cardWidth * 0.32;
      this.cardDivider.lineStyle(1 * DPR, 0x1a2130, 0.6);
      this.cardDivider.lineBetween(width / 2 - colStep / 2, dividerY + 6 * DPR, width / 2 - colStep / 2, cardTop + cardHeight - 6 * DPR);
      this.cardDivider.lineBetween(width / 2 + colStep / 2, dividerY + 6 * DPR, width / 2 + colStep / 2, cardTop + cardHeight - 6 * DPR);
    }

    const colStep = cardWidth * 0.32;
    const col1X = width / 2 - colStep;
    const col2X = width / 2;
    const col3X = width / 2 + colStep;

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

    // 3. Селектор карты (Сектор Омега / Био-Реактор / Катакомбы)
    const mapBoxY = cardTop + cardHeight + 12 * DPR;
    const mapBoxH = 160 * DPR;
    const mapBoxW = cardWidth;
    const mapBoxX = width / 2 - mapBoxW / 2;

    this.mapBoxX = mapBoxX;
    this.mapBoxY = mapBoxY;
    this.mapBoxW = mapBoxW;
    this.mapBoxH = mapBoxH;

    const mapDef = GAME_MAPS[this.selectedMap] || GAME_MAPS.lab;
    if (this.mapBoxBg) {
      this.mapBoxBg.clear();
      this.mapBoxBg.fillStyle(0x131722, 0.95);
      this.mapBoxBg.fillRoundedRect(mapBoxX, mapBoxY, mapBoxW, mapBoxH, 14 * DPR);
      this.mapBoxBg.lineStyle(1.6 * DPR, (mapDef.theme && mapDef.theme.accentColor) || 0x242d40, 1);
      this.mapBoxBg.strokeRoundedRect(mapBoxX, mapBoxY, mapBoxW, mapBoxH, 14 * DPR);
    }

    if (this.mapLabel) {
      this.mapLabel.setPosition(width / 2, mapBoxY + 14 * DPR);
      this.mapLabel.setText(`КАРТА · ${mapDef.badge || ''}`);
      this.mapLabel.setStyle({ fontSize: `${Math.round(11 * DPR)}px` });
    }
    const mapTitleFont = Math.min(15 * DPR, Math.round(mapBoxW * 0.038));
    if (this.mapPrevBtn) {
      this.mapPrevBtn.setPosition(mapBoxX + 24 * DPR, mapBoxY + 36 * DPR);
      this.mapPrevBtn.setStyle({ fontSize: `${Math.round(22 * DPR)}px` });
    }
    if (this.mapTitle) {
      this.mapTitle.setPosition(width / 2, mapBoxY + 36 * DPR);
      this.mapTitle.setStyle({ fontSize: `${mapTitleFont}px` });
    }
    if (this.mapNextBtn) {
      this.mapNextBtn.setPosition(mapBoxX + mapBoxW - 24 * DPR, mapBoxY + 36 * DPR);
      this.mapNextBtn.setStyle({ fontSize: `${Math.round(22 * DPR)}px` });
    }

    // Отрисовка мини-карты кодом в изометрии
    this.renderMapPreview(mapDef, width / 2, mapBoxY + 86 * DPR, mapBoxW * 0.65, 52 * DPR);

    const elevCount = (mapDef.elevations && mapDef.elevations.length) || 0;
    if (this.mapStatsText) {
      this.mapStatsText.setPosition(width / 2, mapBoxY + 138 * DPR);
      this.mapStatsText.setText(`Возвышенности: ${elevCount} · 35 волн`);
      this.mapStatsText.setStyle({ fontSize: `${Math.min(11.5 * DPR, Math.round(mapBoxW * 0.030))}px` });
    }

    if (this.mapDesc) {
      this.mapDesc.setText('').setVisible(false);
    }

    // 4. Селектор сложности (Лёгкий / Средний / Трудный)
    const diffBoxY = mapBoxY + mapBoxH + 12 * DPR;
    const diffLabelY = diffBoxY + 8 * DPR;
    if (this.diffLabel) {
      this.diffLabel.setPosition(width / 2, diffLabelY);
      this.diffLabel.setStyle({ fontSize: `${Math.round(12 * DPR)}px` });
    }

    const btnGap = 8 * DPR;
    const diffBtnW = Math.floor((cardWidth - 2 * btnGap) / 3);
    const diffBtnH = 38 * DPR;
    const diffBtnY = diffBoxY + 34 * DPR;

    const diffKeys = ['easy', 'medium', 'hard'];
    diffKeys.forEach((k, idx) => {
      const btn = this.diffButtons && this.diffButtons[k];
      if (btn) {
        const bx = width / 2 + (idx - 1) * (diffBtnW + btnGap);
        btn.setPosition(bx, diffBtnY);
        btn.setStyle({ fontSize: `${Math.round(14 * DPR)}px`, padding: { x: 8 * DPR, y: 7 * DPR } });
        if (btn._roundItem) {
          btn._roundItem.w = diffBtnW;
          btn._roundItem.h = diffBtnH;
        }
      }
    });

    if (this.diffDesc) {
      this.diffDesc.setText('').setVisible(false);
    }

    // 5. Кнопка В БОЙ
    if (this.playButton) {
      const playY = Math.min(height * 0.83, diffBoxY + 86 * DPR);
      const playFont = `${Math.round(Math.min(24 * DPR, Math.max(20 * DPR, size * 0.050)))}px`;
      this.playButton.setPosition(width / 2, playY);
      this.playButton.setStyle({
        fontSize: playFont,
        padding: { x: 42 * DPR, y: 13 * DPR },
      });
    }

    // Инвентарь
    if (this.inventoryTitle) {
      this.inventoryTitle.setPosition(width / 2, height * 0.075);
      this.inventoryTitle.setStyle({ fontSize: `${Math.round(Math.max(22 * DPR, size * 0.050))}px` });
    }
    if (this.inventorySubtitle) {
      this.inventorySubtitle.setPosition(width / 2, height * 0.115);
      this.inventorySubtitle.setStyle({ 
        fontSize: `${Math.round(Math.min(12.5 * DPR, size * 0.027))}px`,
        wordWrap: { width: width * 0.9 },
        align: 'center'
      });
    }
    const rowScale = Math.min((width * 0.92) / 320, 1.15 * DPR);
    const rowStep = 78 * rowScale + 8 * DPR;
    const invStart = height * 0.16 + (39 * rowScale);
    this.inventoryRows.forEach((row, index) => {
      row.setPosition(width / 2, invStart + index * rowStep);
      row.setScale(rowScale);
    });

    if (this.towerDetailModal && this.towerDetailModal.visible && this.selectedTowerKey) {
      this.renderTowerDetail();
    }

    // Топ игроков
    if (this.topTitle) {
      this.topTitle.setPosition(width / 2, height * 0.065);
      this.topTitle.setStyle({ fontSize: `${Math.round(Math.max(22 * DPR, size * 0.050))}px` });
    }
    if (this.statsText) {
      this.statsText.setPosition(width / 2, height * 0.115);
      this.statsText.setStyle({
        fontSize: `${Math.round(Math.min(13 * DPR, size * 0.028))}px`,
        wordWrap: { width: Math.min(width * 0.92, 520 * DPR) },
      });
    }

    const topCardW = Math.min(width * 0.94, 550 * DPR);
    const topCardTop = height * 0.16;
    const topCardBottom = height * 0.88;
    const topCardH = topCardBottom - topCardTop;
    const topCardX = width / 2 - topCardW / 2;

    this.topCardW = topCardW;
    this.topCardH = topCardH;
    this.topCardX = topCardX;
    this.topCardTop = topCardTop;
    this.topCardInnerTop = topCardTop + 8 * DPR;
    this.topVisibleH = topCardH - 16 * DPR;
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

    this.refreshTop();

    // Боевые задания (Пасс)
    if (this.passTitle) {
      this.passTitle.setPosition(width / 2, height * 0.075);
      this.passTitle.setStyle({ fontSize: `${Math.round(Math.max(22 * DPR, size * 0.050))}px` });
    }
    if (this.passSubtitle) {
      this.passSubtitle.setPosition(width / 2, height * 0.115);
      this.passSubtitle.setStyle({ 
        fontSize: `${Math.round(Math.min(12.5 * DPR, size * 0.027))}px`,
        wordWrap: { width: width * 0.9 },
        align: 'center'
      });
    }

    const passCardW = Math.min(width * 0.94, 550 * DPR);
    const bannerTop = height * 0.155;
    const bannerH = 48 * DPR;

    if (this.passLockBanner) {
      this.passLockBanner.setPosition(width / 2, bannerTop + bannerH * 0.5);
      const bannerScale = Math.min((width * 0.92) / 320, 1.15 * DPR);
      this.passLockBanner.setScale(bannerScale);
    }

    const passCardTop = bannerTop + bannerH + 10 * DPR;
    const passCardBottom = height * 0.88;
    const passCardH = passCardBottom - passCardTop;
    const passCardX = width / 2 - passCardW / 2;

    this.passCardW = passCardW;
    this.passCardH = passCardH;
    this.passCardX = passCardX;
    this.passCardTop = passCardTop;
    this.passCardInnerTop = passCardTop + 8 * DPR;
    this.passVisibleH = passCardH - 16 * DPR;
    this.passListBaseY = this.passCardInnerTop;

    if (this.passCardGfx) {
      this.passCardGfx.clear();
      this.passCardGfx.fillStyle(0x131722, 0.95);
      this.passCardGfx.fillRoundedRect(passCardX, passCardTop, passCardW, passCardH, 14 * DPR);
      this.passCardGfx.lineStyle(1.5 * DPR, 0x242d40, 1);
      this.passCardGfx.strokeRoundedRect(passCardX, passCardTop, passCardW, passCardH, 14 * DPR);
    }
    if (this.passMaskGfx) {
      this.passMaskGfx.clear();
      this.passMaskGfx.fillStyle(0xffffff);
      this.passMaskGfx.fillRect(passCardX + 2, passCardTop + 6 * DPR, passCardW - 4, passCardH - 12 * DPR);
    }
    if (this.passScrollZone) {
      this.passScrollZone.setPosition(passCardX, passCardTop).setSize(passCardW, passCardH);
    }

    const questRowScale = Math.min((passCardW * 0.94) / 320, 1.15 * DPR);
    const questStep = 86 * questRowScale + 10 * DPR;
    if (this.questRows && this.questRows.length > 0) {
      this.questRows.forEach((row, idx) => {
        row.setPosition(width / 2, idx * questStep + 44 * questRowScale);
        row.setScale(questRowScale);
      });
      this.passContentH = this.questRows.length * questStep + 16 * DPR;
    } else {
      this.passContentH = 0;
    }
    this.passMinScrollOffset = Math.min(0, this.passVisibleH - this.passContentH);
    this.applyPassScroll(this.passScrollOffset || 0);

    // Магазин
    if (this.shopTitle) {
      this.shopTitle.setPosition(width / 2, height * 0.075);
      this.shopTitle.setStyle({ fontSize: `${Math.round(Math.max(22 * DPR, size * 0.050))}px` });
    }
    if (this.shopSubtitle) {
      this.shopSubtitle.setPosition(width / 2, height * 0.115);
      this.shopSubtitle.setStyle({ 
        fontSize: `${Math.round(Math.max(14 * DPR, size * 0.030))}px`,
        color: "#94a3b8",
        wordWrap: { width: width * 0.9 },
        align: "center"
      });
    }

    const shopCardW = Math.min(width * 0.94, 550 * DPR);
    const shopCardTop = height * 0.16;
    const shopCardBottom = height * 0.88;
    const shopCardH = shopCardBottom - shopCardTop;
    const shopCardX = width / 2 - shopCardW / 2;

    this.shopCardW = shopCardW;
    this.shopCardH = shopCardH;
    this.shopCardX = shopCardX;
    this.shopCardTop = shopCardTop;
    this.shopCardInnerTop = shopCardTop + 8 * DPR;
    this.shopVisibleH = shopCardH - 16 * DPR;
    this.shopListBaseY = this.shopCardInnerTop;

    if (this.shopCardGfx) {
      this.shopCardGfx.clear();
      this.shopCardGfx.fillStyle(0x131722, 0.95);
      this.shopCardGfx.fillRoundedRect(shopCardX, shopCardTop, shopCardW, shopCardH, 14 * DPR);
      this.shopCardGfx.lineStyle(1.5 * DPR, 0x242d40, 1);
      this.shopCardGfx.strokeRoundedRect(shopCardX, shopCardTop, shopCardW, shopCardH, 14 * DPR);
    }
    if (this.shopMaskGfx) {
      this.shopMaskGfx.clear();
      this.shopMaskGfx.fillStyle(0xffffff);
      this.shopMaskGfx.fillRect(shopCardX + 2, shopCardTop + 6 * DPR, shopCardW - 4, shopCardH - 12 * DPR);
    }
    if (this.shopScrollZone) {
      this.shopScrollZone.setPosition(shopCardX, shopCardTop).setSize(shopCardW, shopCardH);
    }

    const shopRowScale = Math.min((shopCardW * 0.94) / 320, 1.15 * DPR);
    let curY = 16 * DPR;
    this.shopRows.forEach((r) => {
      if (r.isHeader) {
        r.item.setPosition(width / 2, curY + 16 * DPR);
        r.item.setStyle({
          fontSize: `${Math.round(Math.max(16 * DPR, size * 0.038))}px`,
          color: "#ff6b7a",
          fontStyle: "bold",
        });
        curY += 38 * DPR;
      } else {
        r.item.setPosition(width / 2, curY + 40 * shopRowScale);
        r.item.setScale(shopRowScale);
        curY += 80 * shopRowScale + 12 * DPR;
      }
    });
    this.shopContentH = curY + 12 * DPR;
    this.shopMinScrollOffset = Math.min(0, this.shopVisibleH - this.shopContentH);
    this.applyShopScroll(this.shopScrollOffset || 0);

    // Вкладки внизу (порядок: Инвентарь, Меню, Пасс, Топ, Магазин)
    const tabY = height * 0.94;
    const tabs = [this.tabInventory, this.tabLobby, this.tabPass, this.tabTop, this.tabShop];

    // Адаптивный размер шрифта и отступов под ширину экрана
    const tabFontSize = Math.round(Math.min(15 * DPR, Math.max(11 * DPR, width >= 600 ? 14.5 * DPR : width * 0.031)));
    const padX = Math.round(Math.min(14 * DPR, Math.max(5 * DPR, width >= 600 ? 12 * DPR : width * 0.015)));
    const padY = Math.round(width >= 600 ? 8 * DPR : 6 * DPR);
    const tabStyle = {
      fontSize: `${tabFontSize}px`,
      padding: { x: padX, y: padY }
    };

    tabs.forEach(tab => {
      if (tab) {
        tab.setStyle(tabStyle);
        if (tab.updateText) tab.updateText();
      }
    });

    let totalTabsW = 0;
    tabs.forEach(tab => {
      if (tab) totalTabsW += tab.displayWidth;
    });

    const maxBarW = Math.min(width * 0.95, 540 * DPR);
    const gap = Math.max(3 * DPR, (maxBarW - totalTabsW) / (tabs.length - 1));
    const actualTotalW = totalTabsW + gap * (tabs.length - 1);
    let startX = (width - actualTotalW) / 2;

    tabs.forEach(tab => {
      if (tab) {
        const halfW = tab.displayWidth / 2;
        tab.setPosition(Math.round(startX + halfW), Math.round(tabY));
        startX += tab.displayWidth + gap;
      }
    });

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

  init(data) {
    const savedDiff = localStorage.getItem('spore_td_difficulty') || localStorage.getItem('spore_difficulty') || 'medium';
    const savedMap = localStorage.getItem('spore_td_map') || localStorage.getItem('spore_map') || 'lab';
    this.selectedDifficulty = (data && data.difficulty) || savedDiff;
    this.selectedMap = (data && data.map) || savedMap;
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

    // Направленные спрайты (8 сторон): корпус, крепление и пушка. Если файлов ещё нет —
    // они просто не загрузятся, игра идёт на старых спрайтах (fallback).
    for (const key in TOWER_TYPES) {
      this.load.image(`${key}_mount`, `assets/${key}_mount.png${ASSET_VER}`);
      for (const dir of DIRECTIONS) {
        this.load.image(`${key}_base_${dir}`, `assets/${key}_base_${dir}.png${ASSET_VER}`);
        this.load.image(`${key}_mount_${dir}`, `assets/${key}_mount_${dir}.png${ASSET_VER}`);
        for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
          this.load.image(`${key}_base_${level}_${dir}`, `assets/${key}_base_${level}_${dir}.png${ASSET_VER}`);
          this.load.image(`${key}_mount_${level}_${dir}`, `assets/${key}_mount_${level}_${dir}.png${ASSET_VER}`);
          this.load.image(`${key}_gun_${level}_${dir}`, `assets/${key}_gun_${level}_${dir}.png${ASSET_VER}`);
        }
      }
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        this.load.image(`${key}_base_${level}`, `assets/${key}_base_${level}.png${ASSET_VER}`);
        this.load.image(`${key}_mount_${level}`, `assets/${key}_mount_${level}.png${ASSET_VER}`);
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
          /_base_\d+_[a-z]+$/.test(file.key) ||
          /_mount.*$/.test(file.key) ||
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

    // Настройки выбранной сложности и карты
    this.diffDef = GAME_DIFFICULTIES[this.selectedDifficulty] || GAME_DIFFICULTIES.easy;
    this.mapDef = GAME_MAPS[this.selectedMap] || GAME_MAPS.lab;

    // Данные игрока и роль (creator / tester / player) — роль читается из Firebase.
    this.playerInfo = this.getPlayerInfo();
    this.playerRole = 'player';
    this.playerBest = { wave: 0, gold: 0 };

    // Состояние игрока (экономика и здоровье базы с учётом выбранной сложности).
    this.gold = (this.diffDef && this.diffDef.startGold) !== undefined ? this.diffDef.startGold : START_GOLD;
    this.maxBaseHp = (this.diffDef && this.diffDef.baseHp) !== undefined ? this.diffDef.baseHp : START_BASE_HP;
    this.lives = this.maxBaseHp;
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
    this.aimingTower = null;
    this.isTowerViewMode = false; // режим просмотра (окно скрыто, круг остаётся)
    this.viewModeTappedGround = false;
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

    // Маршрут врагов строим по контрольным точкам выбранной карты.
    this.route = buildRoute(this.mapDef.waypoints);

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
      sliceSheet(this, `${key}_mount_sheet`, `${key}_mount`);
      for (let level = 1; level <= TOWER_MAX_LEVEL; level++) {
        sliceSheet(this, `${key}_base_${level}_sheet`, `${key}_base_${level}`);
        sliceSheet(this, `${key}_mount_${level}_sheet`, `${key}_mount_${level}`);
        sliceSheet(this, `${key}_gun_${level}_sheet`, `${key}_gun_${level}`);
      }
    }
    sliceSheet(this, 'template_base_sheet', 'template_base');
    initProceduralWeaponTextures(this);

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
        const keys = this.activeDeckKeys || (typeof getPlayerDeck === 'function' ? getPlayerDeck() : Object.keys(TOWER_TYPES));
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
    // Меню башни (в стиле окна прокачки из референса: иконка, Lv., полоса уровней, карточка).
    // Все интерактивные элементы — прямые объекты со scrollFactor(0) и depth(102-105).
    this.towerMenuBg = this.add
      .rectangle(0, 0, 260 * DPR, 260 * DPR, 0x000000, 0.001)
      .setDepth(102)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive();
    this.towerMenuBg.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
    });

    this.towerMenuGfx = this.add.graphics().setDepth(103).setScrollFactor(0).setVisible(false);

    // Иконка башни в квадратной рамке
    this.towerMenuIconBase = this.add
      .image(0, 0, 'tower')
      .setDisplaySize(38 * DPR, 38 * DPR)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false);

    this.towerMenuIconGun = this.add
      .image(0, 0, 'tower')
      .setDisplaySize(38 * DPR, 38 * DPR)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false);

    // Заголовок: Lv. X и название оружия
    this.towerMenuHeader = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${14 * DPR}px`,
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0, 0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false);

    // Кнопка закрытия окна (крестик в правом верхнем углу)
    this.towerMenuClose = this.add
      .text(0, 0, '✖', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${13 * DPR}px`,
        color: '#8a94a6',
        padding: { x: 6 * DPR, y: 3 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerMenuClose.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.closeTowerMenu();
    });

    // Зелёная кнопка улучшения
    this.towerMenuUpgrade = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${12 * DPR}px`,
        color: '#ffffff',
        fontStyle: 'bold',
        padding: { x: 8 * DPR, y: 5 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerMenuUpgrade.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.upgradeSelectedTower();
    });

    // Карточка с характеристиками
    this.towerMenuStats = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${11.5 * DPR}px`,
        color: '#c8d1dc',
        lineSpacing: 3 * DPR,
      })
      .setOrigin(0, 0)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false);

    // Кнопка поворота (для стационарных установок)
    this.towerMenuRotate = this.add
      .text(0, 0, '🔄 Повернуть', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${11 * DPR}px`,
        color: '#f39c12',
        fontStyle: 'bold',
        padding: { x: 7 * DPR, y: 4 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerMenuRotate.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.startAimingTower();
    });

    // Кнопки подтверждения / отмены поворота
    this.towerMenuConfirmRotate = this.add
      .text(0, 0, '✅ Зафиксировать', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${12 * DPR}px`,
        color: '#2ecc71',
        fontStyle: 'bold',
        padding: { x: 10 * DPR, y: 5 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerMenuConfirmRotate.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.confirmAimingTower();
    });

    this.towerMenuCancelRotate = this.add
      .text(0, 0, '✖ Отмена', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${12 * DPR}px`,
        color: '#95a5a6',
        fontStyle: 'bold',
        padding: { x: 10 * DPR, y: 5 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerMenuCancelRotate.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.cancelAimingTower();
    });

    // Кнопка режима просмотра
    this.towerMenuView = this.add
      .text(0, 0, '👁 Просмотр', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${11 * DPR}px`,
        color: '#48dbfb',
        fontStyle: 'bold',
        padding: { x: 7 * DPR, y: 4 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerMenuView.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.enterTowerViewMode();
    });

    // Кнопка продажи башни
    this.towerMenuSell = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${11 * DPR}px`,
        color: '#e74c3c',
        fontStyle: 'bold',
        padding: { x: 7 * DPR, y: 4 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerMenuSell.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.sellSelectedTower();
    });

    // Плашка режима просмотра (когда окно скрыто, а круг оставлен)
    this.towerViewPill = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: `${13 * DPR}px`,
        color: '#ffffff',
        padding: { x: 14 * DPR, y: 7 * DPR },
      })
      .setOrigin(0.5)
      .setDepth(104)
      .setScrollFactor(0)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.towerViewPill.on('pointerdown', (pointer, localX, localY, event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      this.exitTowerViewMode(true);
    });

    // Совместимость со старым кодом
    this.towerMenuTitle = this.towerMenuStats;

    this.towerMenuParts = [
      this.towerMenuBg,
      this.towerMenuGfx,
      this.towerMenuIconBase,
      this.towerMenuIconGun,
      this.towerMenuHeader,
      this.towerMenuClose,
      this.towerMenuUpgrade,
      this.towerMenuStats,
      this.towerMenuRotate,
      this.towerMenuConfirmRotate,
      this.towerMenuCancelRotate,
      this.towerMenuView,
      this.towerMenuSell,
    ];

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
    // Скруглённые стилизованные кнопки окна прокачки
    roundTarget(this, this.towerMenuUpgrade, {
      color: 0x27ae60,
      alpha: 1,
      radius: 8 * DPR,
      strokeColor: 0x4cd137,
      strokeAlpha: 0.9,
      strokeWidth: 1.5 * DPR,
    });
    roundTarget(this, this.towerMenuClose, {
      color: 0x1a1f2b,
      alpha: 1,
      radius: 6 * DPR,
      strokeColor: 0x2f384a,
      strokeAlpha: 0.9,
      strokeWidth: 1 * DPR,
    });
    roundTarget(this, this.towerMenuView, {
      color: 0x131a24,
      alpha: 1,
      radius: 7 * DPR,
      strokeColor: 0x48dbfb,
      strokeAlpha: 0.8,
      strokeWidth: 1 * DPR,
    });
    roundTarget(this, this.towerMenuSell, {
      color: 0x221417,
      alpha: 1,
      radius: 7 * DPR,
      strokeColor: 0xe74c3c,
      strokeAlpha: 0.8,
      strokeWidth: 1 * DPR,
    });
    roundTarget(this, this.towerMenuRotate, {
      color: 0x241a10,
      alpha: 1,
      radius: 7 * DPR,
      strokeColor: 0xf39c12,
      strokeAlpha: 0.8,
      strokeWidth: 1 * DPR,
    });
    roundTarget(this, this.towerMenuConfirmRotate, {
      color: 0x14281a,
      alpha: 1,
      radius: 7 * DPR,
      strokeColor: 0x2ecc71,
      strokeAlpha: 0.9,
      strokeWidth: 1.5 * DPR,
    });
    roundTarget(this, this.towerMenuCancelRotate, {
      color: 0x1e222a,
      alpha: 1,
      radius: 7 * DPR,
      strokeColor: 0x95a5a6,
      strokeAlpha: 0.8,
      strokeWidth: 1 * DPR,
    });
    // Плашка режима просмотра — скруглённая с голубой обводкой.
    roundTarget(this, this.towerViewPill, {
      color: 0x151515,
      alpha: 0.95,
      radius: 12 * DPR,
      strokeColor: 0x48dbfb,
      strokeAlpha: 0.9,
      strokeWidth: 1.5 * DPR,
    });
  }

  // Обновляем текст панели при изменении волны/здоровья базы/золота.
  updateUI() {
    const nick = this.playerInfo ? this.playerInfo.nick : 'Игрок';
    const prefix = this.roleLabel(this.playerRole);
    const nameLine = prefix ? `${nick} · ${prefix}` : nick;
    const baseText = this.infiniteLives ? '∞' : `${this.lives} HP`;
    const maxWaves = (this.diffDef && this.diffDef.totalWaves) || 20;

    this.uiText.setText(
      `${nameLine}\nВолна: ${this.currentWave}/${maxWaves}\nБаза: ${baseText}\nЗолото: ${this.gold}`
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
    const isProduction = host === 'telegram-tower-defense.vercel.app';
    if (!IS_BETA_BUILD || isProduction) {
      if (this.cheatButton) this.cheatButton.setVisible(false);
      this.cheatOpen = false;
      if (this.cheatParts) for (const p of this.cheatParts) p.setVisible(false);
      return;
    }
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    const isBeta = host.includes('git-beta') || host.includes('beta'); // тестовый деплой
    const staff =
      this.playerRole === 'tester' || this.playerRole === 'creator' || isLocal || isBeta;
    const show = (IS_BETA_BUILD || staff) && !this.isGameOver;
    if (this.cheatButton) this.cheatButton.setVisible(show);
    if (!show) {
      this.cheatOpen = false;
      if (this.cheatParts) for (const p of this.cheatParts) p.setVisible(false);
    } else if (this.cheatOpen && this.cheatParts) {
      for (const p of this.cheatParts) p.setVisible(true);
    }
  }

  toggleCheat() {
    const host = window.location.hostname;
    const isProduction = host === 'telegram-tower-defense.vercel.app';
    if (!IS_BETA_BUILD || isProduction) return;
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
      this.cheatLivesButton.setText(`❤ База ∞: ${this.infiniteLives ? 'вкл' : 'выкл'}`);
    }
    this.updateUI();
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
        normal: 'Базовый мутант',
        fast: 'Мутант-бегун',
        armored: 'Бронированный',
        stalker: 'Сталкер-охотник',
        regenerator: 'Регенератор',
        tank: 'Мутант-танк',
        splitter: 'Спороносец',
        small: 'Мелкая спора',
        shielded: 'Щитоносец',
        boss: 'Альфа-Спора',
      };
      let text = `${NAMES[e.typeKey] || e.typeKey}${e.isCured ? ' (Вылечен)' : ''}\nHP ${Math.max(0, Math.ceil(e.hp))}/${e.maxHp}`;
      if (e.shield > 0) text += `\nЩит ${Math.ceil(e.shield)}`;
      if (e.regen > 0) text += `\nРеген ${Math.round(e.regen)} HP/с`;
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

  // Визуальный эффект распыления газа (облако зелёных частиц/пуфов)
  createGasSpray(startX, startY, angle, distance, level = 1) {
    const count = level >= 4 ? 4 : (level === 3 ? 5 : 6);
    const duration = level >= 4 ? Phaser.Math.Between(220, 300) : Phaser.Math.Between(260, 380);
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 0.55;
      const a = angle + spread;
      const dist = Phaser.Math.Between(distance * 0.35, distance * 0.95);
      const targetX = startX + Math.cos(a) * dist;
      const targetY = startY + Math.sin(a) * dist * (ISO_HH / ISO_HW);

      const puff = this.add.circle(startX, startY, 7 * DPR, 0x2ecc71, 0.65).setDepth(45);
      this.tweens.add({
        targets: puff,
        x: targetX,
        y: targetY,
        scaleX: 2.2,
        scaleY: 2.2,
        alpha: 0,
        duration: duration,
        ease: 'Quad.easeOut',
        onComplete: () => puff.destroy(),
      });
    }
  }

  // Визуальный эффект непрерывной струи газа (для башен без кд)
  createContinuousGasSpray(startX, startY, angle, distance) {
    const spread = (Math.random() - 0.5) * 0.45;
    const a = angle + spread;
    const dist = Phaser.Math.Between(distance * 0.35, distance * 0.95);
    const targetX = startX + Math.cos(a) * dist;
    const targetY = startY + Math.sin(a) * dist * (ISO_HH / ISO_HW);

    const puff = this.add.circle(startX, startY, 6 * DPR, 0x2ecc71, 0.65).setDepth(45);
    this.tweens.add({
      targets: puff,
      x: targetX,
      y: targetY,
      scaleX: 2.2,
      scaleY: 2.2,
      alpha: 0,
      duration: Phaser.Math.Between(220, 320),
      ease: 'Quad.easeOut',
      onComplete: () => puff.destroy(),
    });
  }

  // Визуальный эффект цепной молнии между целями
  createChainLightningVisual(startPos, targets) {
    if (!targets || targets.length === 0) return;

    const g = this.add.graphics().setDepth(47);

    const drawBolt = (x1, y1, x2, y2, color, width, alpha) => {
      g.lineStyle(width * DPR, color, alpha);
      const dist = Math.hypot(x2 - x1, y2 - y1);
      const steps = Math.max(3, Math.min(8, Math.floor(dist / (18 * DPR))));
      const dx = (x2 - x1) / steps;
      const dy = (y2 - y1) / steps;

      const nx = -dy / (dist || 1);
      const ny = dx / (dist || 1);

      g.beginPath();
      g.moveTo(x1, y1);
      for (let s = 1; s < steps; s++) {
        const offset = Phaser.Math.Between(-9, 9) * DPR;
        const nextX = x1 + dx * s + nx * offset;
        const nextY = y1 + dy * s + ny * offset;
        g.lineTo(nextX, nextY);
      }
      g.lineTo(x2, y2);
      g.strokePath();
    };

    const points = [{ x: startPos.x, y: startPos.y }, ...targets.map(t => ({ x: t.x, y: t.y }))];

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      drawBolt(p1.x, p1.y, p2.x, p2.y, 0x00d2ff, 3.5, 0.7);
      drawBolt(p1.x, p1.y, p2.x, p2.y, 0xffffff, 1.5, 1.0);
    }

    targets.forEach(t => {
      const spark = this.add.circle(t.x, t.y, 9 * DPR, 0x00ffff, 0.75).setDepth(48);
      this.tweens.add({
        targets: spark,
        scaleX: 1.8,
        scaleY: 1.8,
        alpha: 0,
        duration: 180,
        ease: 'Quad.easeOut',
        onComplete: () => spark.destroy(),
      });
    });

    this.tweens.add({
      targets: g,
      alpha: 0,
      duration: 140,
      ease: 'Quad.easeOut',
      onComplete: () => g.destroy(),
    });
  }

  // Физическая кинетическая вспышка и разлёт искр при попадании снаряда
  createHitSpark(x, y) {
    const flash = this.add.circle(x, y, 5 * DPR, 0xfff0aa, 0.95).setDepth(550);
    this.tweens.add({
      targets: flash,
      scaleX: 1.8,
      scaleY: 1.8,
      alpha: 0,
      duration: 110,
      ease: 'Quad.easeOut',
      onComplete: () => flash.destroy(),
    });

    for (let i = 0; i < 4; i++) {
      const spark = this.add.circle(x, y, 2 * DPR, 0xffaa33, 0.9).setDepth(551);
      const ang = Math.random() * Math.PI * 2;
      const dist = (8 + Math.random() * 14) * DPR;
      this.tweens.add({
        targets: spark,
        x: x + Math.cos(ang) * dist,
        y: y + Math.sin(ang) * dist,
        alpha: 0,
        scale: 0.3,
        duration: 140 + Math.random() * 100,
        ease: 'Cubic.easeOut',
        onComplete: () => spark.destroy(),
      });
    }
  }

  // Всплывающий текст (для лечения, бонусов и статусов)
  showFloatingText(x, y, text, color = 0x2ecc71) {
    const colorStr = typeof color === 'string' ? color : `#${color.toString(16).padStart(6, '0')}`;
    const t = this.add
      .text(x, y, text, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(13 * DPR)}px`,
        fontStyle: 'bold',
        color: colorStr,
        stroke: '#000000',
        strokeThickness: 3 * DPR,
      })
      .setOrigin(0.5)
      .setDepth(150);

    this.tweens.add({
      targets: t,
      y: y - 24 * DPR,
      alpha: 0,
      duration: 800,
      ease: 'Quad.easeOut',
      onComplete: () => t.destroy(),
    });
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
    this.scene.restart({
      difficulty: this.selectedDifficulty,
      map: this.selectedMap,
    });
  }

  // ------------------------- Меню башни -------------------------
  // Открыть меню выбранной башни.
  openTowerMenu(tower) {
    if (this.aimingTower) {
      this.aimingTower.isAiming = false;
    }
    this.isTowerViewMode = false;
    if (this.towerViewPill) {
      this.towerViewPill.setVisible(false);
      updateRoundBgs(this);
    }
    this.selectedTower = tower;
    this.aimingTower = null;
    this.hideEnemyInfo();
    for (const part of this.towerMenuParts) {
      part.setVisible(false);
    }
    this.refreshTowerMenu();
    this.positionTowerMenu();
    this.showRangeRingForTower(tower);
  }

  // Закрыть меню башни.
  closeTowerMenu() {
    this.isTowerViewMode = false;
    this.viewModeTappedGround = false;
    if (this.towerViewPill) {
      this.towerViewPill.setVisible(false);
      updateRoundBgs(this);
    }
    if (this.aimingTower) {
      this.aimingTower.isAiming = false;
      if (this.previousMountAngle !== undefined) {
        this.aimingTower.setMountAngle(this.previousMountAngle);
        this.applyTowerFacing(this.aimingTower);
      }
      this.aimingTower = null;
    }
    this.selectedTower = null;
    if (this.towerMenuGfx) this.towerMenuGfx.clear();
    if (this.towerMenuParts) {
      for (const part of this.towerMenuParts) part.setVisible(false);
    }
    this.clearRangeRing();
    updateRoundBgs(this);
  }

  // Начать свободное наведение сектора установки (1 раз)
  startAimingTower() {
    const tower = this.selectedTower;
    if (!tower || !tower.arc || tower.hasRotated) return;
    this.aimingTower = tower;
    tower.isAiming = true;
    this.previousMountAngle = tower.mountAngle;
    this.refreshTowerMenu();
    this.positionTowerMenu();
  }

  // Подтвердить и зафиксировать сектор навсегда
  confirmAimingTower() {
    if (!this.aimingTower) return;
    const tower = this.aimingTower;
    tower.hasRotated = true; // Зафиксировано навсегда! Только 1 раз!
    tower.isAiming = false;
    this.aimingTower = null;
    this.refreshTowerMenu();
    this.positionTowerMenu();
    this.showRangeRingForTower(tower);
    this.showMessage('Сектор зафиксирован навсегда!');
  }

  // Отменить наведение и вернуть прежний угол
  cancelAimingTower() {
    if (!this.aimingTower) return;
    const tower = this.aimingTower;
    tower.isAiming = false;
    if (this.previousMountAngle !== undefined) {
      tower.setMountAngle(this.previousMountAngle);
      this.applyTowerFacing(tower);
    }
    this.aimingTower = null;
    this.refreshTowerMenu();
    this.positionTowerMenu();
    this.showRangeRingForTower(tower);
  }

  // Кнопка и режим просмотра («Просмотр») доступны только в бете для тестеров
  canUseTowerViewMode() {
    if (!IS_BETA_BUILD) return false;
    const host = typeof window !== 'undefined' && window.location ? window.location.hostname : '';
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    const isBeta = host.includes('git-beta') || host.includes('beta');
    const staff = this.playerRole === 'tester' || this.playerRole === 'creator' || isLocal || isBeta;
    return Boolean(IS_BETA_BUILD || staff);
  }

  // Вход в режим просмотра башни (скрываем окно меню, оставляем круговой радиус)
  enterTowerViewMode() {
    const tower = this.selectedTower;
    if (!tower) return;
    this.isTowerViewMode = true;
    this.viewModeTappedGround = false;
    if (this.towerMenuGfx) this.towerMenuGfx.clear();
    if (this.towerMenuParts) {
      for (const part of this.towerMenuParts) part.setVisible(false);
    }
    this.showRangeRingForTower(tower);
    if (this.towerViewPill) {
      this.towerViewPill
        .setText(`👁 ${tower.getWeaponName()} (ур. ${tower.level})`)
        .setVisible(true);
      this.positionTowerViewPill();
    }
    updateRoundBgs(this);
  }

  // Выход из режима просмотра
  exitTowerViewMode(reopenMenu = true) {
    this.isTowerViewMode = false;
    this.viewModeTappedGround = false;
    if (this.towerViewPill) {
      this.towerViewPill.setVisible(false);
      updateRoundBgs(this);
    }
    if (reopenMenu && this.selectedTower) {
      this.openTowerMenu(this.selectedTower);
    }
  }

  // Позиционирование плашки режима просмотра
  positionTowerViewPill() {
    if (!this.towerViewPill) return;
    const width = this.scale.width;
    const height = this.scale.height;
    this.towerViewPill.setPosition(width / 2, height - 125 * DPR);
    updateRoundBgs(this);
  }

  // Обновить тексты и состояния окна прокачки башни.
  refreshTowerMenu() {
    const tower = this.selectedTower;
    if (!tower) return;

    this.towerMenuBg.setVisible(true);
    this.towerMenuGfx.setVisible(true);
    this.towerMenuIconBase.setVisible(true);
    this.towerMenuHeader.setVisible(true);
    this.towerMenuClose.setVisible(true);
    this.towerMenuStats.setVisible(true);

    // 1. Иконка башни в квадратном превью-боксе
    const base = this.resolveBase(tower.typeKey, DIR_FORWARD);
    const baseKey = (base && base.key) || tower.config.texture;
    this.towerMenuIconBase.setTexture(baseKey);

    const gun = this.resolveGun(tower.typeKey, tower.level, DIR_FORWARD);
    if (gun && this.textures.exists(gun.key)) {
      this.towerMenuIconGun.setTexture(gun.key).setVisible(true);
    } else {
      this.towerMenuIconGun.setVisible(false);
    }

    // 2. Заголовок уровня и имени
    this.towerMenuHeader.setText(`Lv. ${tower.level} · ${tower.getWeaponName()}`);

    const isAiming = Boolean(this.aimingTower);

    if (isAiming) {
      this.towerMenuStats.setText(
        '🎯 НАПРАВЛЕНИЕ СЕКТОРА'
      );
      this.towerMenuConfirmRotate.setVisible(true);
      this.towerMenuCancelRotate.setVisible(true);
      this.towerMenuRotate.setVisible(false);
      this.towerMenuView.setVisible(false);
      this.towerMenuUpgrade.setVisible(false);
      this.towerMenuSell.setVisible(false);
      return;
    }

    this.towerMenuConfirmRotate.setVisible(false);
    this.towerMenuCancelRotate.setVisible(false);
    this.towerMenuView.setVisible(this.canUseTowerViewMode());
    this.towerMenuUpgrade.setVisible(true);
    this.towerMenuSell.setVisible(true);

    const next = tower.config.levels && tower.config.levels[tower.level];

    // 3. Зелёная кнопка улучшения
    if (tower.canUpgrade()) {
      const cost = tower.getUpgradeCost();
      const hasGold = this.gold >= cost;
      this.towerMenuUpgrade.setText(`УЛУЧШИТЬ · ${cost} 🟡`);
      if (this.towerMenuUpgrade._roundItem) {
        this.towerMenuUpgrade._roundItem.color = hasGold ? 0x27ae60 : 0x2c2226;
        this.towerMenuUpgrade._roundItem.strokeColor = hasGold ? 0x4cd137 : 0xd63031;
      }
      this.towerMenuUpgrade.setColor(hasGold ? '#ffffff' : '#ff7675');
    } else {
      this.towerMenuUpgrade.setText('МАКС. УРОВЕНЬ');
      if (this.towerMenuUpgrade._roundItem) {
        this.towerMenuUpgrade._roundItem.color = 0x1b202c;
        this.towerMenuUpgrade._roundItem.strokeColor = 0x2c3547;
      }
      this.towerMenuUpgrade.setColor('#7f8c8d');
    }

    // 4. Характеристики и превью следующего уровня
    let stats = '';
    if (tower.continuous) {
      stats += `Урон: ${tower.damage}/с (БЕЗ КД)`;
      if (next) stats += ` ➔ ${next.damage}/с`;
      stats += `\nРадиус: ${tower.range.toFixed(1)}`;
      if (next && next.range !== undefined) stats += ` ➔ ${next.range.toFixed(1)}`;
      if (tower.cureChance || (next && next.cureChance)) {
        const cur = Math.round((tower.cureChance || 0) * 100);
        const nxt = next && next.cureChance ? Math.round(next.cureChance * 100) : cur;
        stats += `\nИсцеление: ${cur}%/с`;
        if (next && nxt !== cur) stats += ` ➔ ${nxt}%/с`;
      }
    } else if (tower.typeKey === 'disinfector') {
      stats += `Урон: ${tower.damage}`;
      if (next && next.damage !== undefined) stats += ` ➔ ${next.damage}`;
      stats += ` · Сплеш: ${(tower.splashRadius || 1.2).toFixed(1)}`;
      if (next && next.splashRadius !== undefined) stats += ` ➔ ${next.splashRadius.toFixed(1)}`;
      stats += `\nРадиус: ${tower.range.toFixed(1)}`;
      if (next && next.range !== undefined) stats += ` ➔ ${next.range.toFixed(1)}`;
      if (tower.cureChance || (next && next.cureChance)) {
        const cur = Math.round((tower.cureChance || 0) * 100);
        const nxt = next && next.cureChance ? Math.round(next.cureChance * 100) : cur;
        stats += ` · Шанс: ${cur}%`;
        if (next && nxt !== cur) stats += ` ➔ ${nxt}%`;
      }
      if (next && next.continuous) {
        stats += `\n⭐ След. уровень: БЕЗ КД (сплошной газ)!`;
      }
    } else if (tower.typeKey === 'tesla') {
      stats += `Урон: ${tower.damage}`;
      if (next && next.damage !== undefined) stats += ` ➔ ${next.damage}`;
      stats += ` · Цепей: ${tower.chainCount || 2}`;
      if (next && next.chainCount !== undefined) stats += ` ➔ ${next.chainCount}`;
      stats += `\nРадиус: ${tower.range.toFixed(1)}`;
      if (next && next.range !== undefined) stats += ` ➔ ${next.range.toFixed(1)}`;
      stats += ` · Темп: ${tower.fireRate.toFixed(1)}/с`;
      if (next && next.fireRate !== undefined) stats += ` ➔ ${next.fireRate.toFixed(1)}/с`;
    } else {
      const curDmg = tower.dualBarrels ? `${tower.damage} × 2` : `${tower.damage}`;
      const nxtDmg = next ? (next.dualBarrels ? `${next.damage} × 2` : `${next.damage}`) : '';
      stats += `Урон: ${curDmg}`;
      if (next && nxtDmg !== curDmg) stats += ` ➔ ${nxtDmg}`;
      stats += ` · Темп: ${tower.fireRate.toFixed(1)}/с`;
      if (next && next.fireRate !== undefined) stats += ` ➔ ${next.fireRate.toFixed(1)}/с`;
      stats += `\nРадиус: ${tower.range.toFixed(1)}`;
      if (next && next.range !== undefined) stats += ` ➔ ${next.range.toFixed(1)}`;
      const curAcc = Math.round((tower.accuracy !== undefined ? tower.accuracy : 1.0) * 100);
      stats += ` · Точность: ${curAcc}%`;
      if (next && next.accuracy !== undefined) {
        const nextAcc = Math.round(next.accuracy * 100);
        if (nextAcc !== curAcc) {
          stats += ` ➔ ${nextAcc}%`;
        }
      }
      if (next && next.dualBarrels && !tower.dualBarrels) {
        stats += `\n⭐ След. уровень: 2 независимых ствола!`;
      }
    }

    if (tower.arc) {
      if (!tower.hasRotated) {
        stats += `\nСектор: ${Math.round((tower.arc * 180) / Math.PI)}° (не зафиксирован)`;
        this.towerMenuRotate.setVisible(true);
      } else {
        stats += `\nСектор: ${Math.round((tower.arc * 180) / Math.PI)}° (зафиксирован)`;
        this.towerMenuRotate.setVisible(false);
      }
    } else {
      this.towerMenuRotate.setVisible(false);
    }

    this.towerMenuStats.setText(stats);
    this.towerMenuSell.setText(`💰 Продать (+${tower.getSellValue()})`);
  }

  // Расположить окно прокачки рядом с башней и отрисовать дизайн по референсу.
  positionTowerMenu() {
    const tower = this.selectedTower;
    if (!tower) return;

    const width = this.scale.width;
    const height = this.scale.height;
    const isAiming = Boolean(this.aimingTower);
    const hasArcNotRotated = Boolean(tower.arc && !tower.hasRotated && !isAiming);

    const pad = 10 * DPR;
    const menuW = Math.min(width - 20 * DPR, 268 * DPR);
    const menuH = isAiming ? 170 * DPR : (hasArcNotRotated ? 275 * DPR : 248 * DPR);
    const halfW = menuW / 2;
    const halfH = menuH / 2;
    const margin = 8 * DPR;

    // Угол окна (верх-лево) — в точке нажатия (или у башни).
    const anchor = this.menuAnchor || this.worldToUI(tower.gx, tower.gy);
    const x = Phaser.Math.Clamp(anchor.x + halfW, halfW + margin, width - halfW - margin);
    const y = Phaser.Math.Clamp(anchor.y + halfH, halfH + margin, height - halfH - margin);

    const left = x - halfW;
    const top = y - halfH;

    this.towerMenuBg.setSize(menuW, menuH);
    this.towerMenuBg.setPosition(x, y);

    // Размеры и координаты элементов
    const iconBoxSize = 50 * DPR;
    const iconX = left + pad;
    const iconY = top + pad;
    const iconCenterX = iconX + iconBoxSize / 2;
    const iconCenterY = iconY + iconBoxSize / 2;

    const closeSize = 22 * DPR;
    const closeX = left + menuW - pad - closeSize / 2;
    const closeY = top + pad + closeSize / 2;

    const headerX = iconX + iconBoxSize + 8 * DPR;
    const headerY = top + pad + 12 * DPR;

    const upBtnW = (left + menuW - pad) - headerX;
    const upBtnH = 26 * DPR;
    const upBtnCenterX = headerX + upBtnW / 2;
    const upBtnCenterY = iconY + iconBoxSize - upBtnH / 2;

    const barY = iconY + iconBoxSize + 8 * DPR;
    const barGap = 5 * DPR;
    const segW = (menuW - pad * 2 - 3 * barGap) / 4;
    const segH = 12 * DPR;

    const cardY = barY + segH + 8 * DPR;
    const cardW = menuW - pad * 2;
    const cardH = (top + menuH - pad) - cardY;

    // Отрисовка графики окна, рамки и 4-сегментной полосы прогресса
    const gfx = this.towerMenuGfx;
    gfx.clear();

    // 1. Внешний корпус окна (тёмный контейнер со скруглением и обводкой)
    gfx.fillStyle(0x11141d, 0.97);
    gfx.fillRoundedRect(left, top, menuW, menuH, 14 * DPR);
    gfx.lineStyle(1.5 * DPR, 0x283144, 1);
    gfx.strokeRoundedRect(left, top, menuW, menuH, 14 * DPR);

    // 2. Рамка иконки башни (квадратная со скруглением)
    gfx.fillStyle(0x161a25, 1);
    gfx.fillRoundedRect(iconX, iconY, iconBoxSize, iconBoxSize, 8 * DPR);
    gfx.lineStyle(1.5 * DPR, 0x323c50, 1);
    gfx.strokeRoundedRect(iconX, iconY, iconBoxSize, iconBoxSize, 8 * DPR);

    // 3. Четырёхсегментная полоса уровней с диагональными штрихами
    for (let i = 0; i < 4; i++) {
      const segX = left + pad + i * (segW + barGap);
      const isFilled = tower.level >= i + 2;
      const bgCol = isFilled ? 0x27ae60 : 0x202431;
      const stripeCol = isFilled ? 0x55efc4 : 0x303749;
      const stripeAlpha = isFilled ? 0.45 : 0.6;
      const strokeCol = isFilled ? 0x4cd137 : 0x2d3546;

      gfx.fillStyle(bgCol, 1);
      gfx.fillRoundedRect(segX, barY, segW, segH, 4 * DPR);

      // Диагональные полосы под углом 45 градусов
      for (let off = -segH; off < segW + segH; off += 7 * DPR) {
        const x1 = Math.max(segX, segX + off);
        const y1 = barY + (x1 - (segX + off));
        const x2 = Math.min(segX + segW, segX + off + segH);
        const y2 = barY + (x2 - (segX + off));
        if (x2 > x1 && y1 >= barY && y2 <= barY + segH) {
          gfx.lineStyle(2 * DPR, stripeCol, stripeAlpha);
          gfx.lineBetween(x1, y1, x2, y2);
        }
      }

      gfx.lineStyle(1.5 * DPR, strokeCol, 0.95);
      gfx.strokeRoundedRect(segX, barY, segW, segH, 4 * DPR);
    }

    // 4. Нижняя карточка характеристик
    gfx.fillStyle(0x151823, 1);
    gfx.fillRoundedRect(left + pad, cardY, cardW, cardH, 10 * DPR);
    gfx.lineStyle(1 * DPR, 0x283042, 1);
    gfx.strokeRoundedRect(left + pad, cardY, cardW, cardH, 10 * DPR);

    // Размещение спрайтов и текста
    this.towerMenuIconBase.setPosition(iconCenterX, iconCenterY).setDisplaySize(38 * DPR, 38 * DPR);
    if (this.towerMenuIconGun.visible) {
      this.towerMenuIconGun.setPosition(iconCenterX, iconCenterY).setDisplaySize(38 * DPR, 38 * DPR);
    }

    this.towerMenuHeader.setPosition(headerX, headerY);
    this.towerMenuClose.setPosition(closeX, closeY);

    if (!isAiming) {
      this.towerMenuUpgrade.setPosition(upBtnCenterX, upBtnCenterY);
    }

    this.towerMenuStats.setPosition(left + pad + 10 * DPR, cardY + 8 * DPR);

    const btnY = cardY + cardH - 18 * DPR;

    const showView = this.canUseTowerViewMode();
    if (isAiming) {
      this.towerMenuConfirmRotate.setPosition(left + pad + cardW * 0.30, btnY);
      this.towerMenuCancelRotate.setPosition(left + pad + cardW * 0.72, btnY);
    } else if (hasArcNotRotated) {
      if (showView) {
        this.towerMenuView.setPosition(left + pad + cardW * 0.20, btnY);
        this.towerMenuRotate.setPosition(left + pad + cardW * 0.52, btnY);
        this.towerMenuSell.setPosition(left + pad + cardW * 0.82, btnY);
      } else {
        this.towerMenuRotate.setPosition(left + pad + cardW * 0.30, btnY);
        this.towerMenuSell.setPosition(left + pad + cardW * 0.72, btnY);
      }
    } else {
      if (showView) {
        this.towerMenuView.setPosition(left + pad + cardW * 0.28, btnY);
        this.towerMenuSell.setPosition(left + pad + cardW * 0.72, btnY);
      } else {
        this.towerMenuSell.setPosition(left + pad + cardW * 0.50, btnY);
      }
    }

    updateRoundBgs(this);
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
    this.positionTowerMenu();
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
  // Создаём кнопки выбора типа башни (внизу экрана) — строго из боевого набора (до 5 слотов).
  createBuildMenu() {
    // Без контейнеров: интерактив в контейнере со scrollFactor(0) ломает клики.
    // Каждая кнопка = отдельные объекты, зафиксированные на экране.
    this.buildButtons = {};
    this.buildButtonWidth = 105 * DPR;
    this.buildGap = 8 * DPR;

    const buttonWidth = this.buildButtonWidth;
    const deck = getPlayerDeck();
    this.activeDeckKeys = deck;

    deck.forEach((key) => {
      const type = TOWER_TYPES[key];
      if (!type) return;

      const bg = this.add
        .rectangle(0, 0, buttonWidth, 86 * DPR, 0x232323, 1)
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
        .setDisplaySize(32 * DPR, 32 * DPR)
        .setDepth(101)
        .setScrollFactor(0);
      const gun = this.resolveGun(key, 1, DIR_FORWARD);
      const iconWeapon = gun
        ? this.add.image(0, 0, gun.key).setDisplaySize(32 * DPR, 32 * DPR).setDepth(101).setScrollFactor(0)
        : null;

      // Название башни
      const nameLabel = this.add
        .text(0, 0, type.name, {
          fontFamily: 'Arial, sans-serif',
          fontSize: `${10 * DPR}px`,
          color: '#ffffff',
          fontStyle: 'bold',
          align: 'center',
        })
        .setOrigin(0.5)
        .setDepth(101)
        .setScrollFactor(0);

      // Стоимость башни отдельной строкой золотистым цветом
      const costLabel = this.add
        .text(0, 0, `${type.cost} 🟡`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: `${10.5 * DPR}px`,
          color: '#f1c40f',
          fontStyle: 'bold',
          align: 'center',
        })
        .setOrigin(0.5)
        .setDepth(101)
        .setScrollFactor(0);

      this.buildButtons[key] = {
        bg: bg,
        iconBase: iconBase,
        iconWeapon: iconWeapon,
        nameLabel: nameLabel,
        costLabel: costLabel,
        label: nameLabel, // обратная совместимость
        type: type,
      };
    });

    this.refreshBuildMenu();
  }

  // Выбрать тип башни для постройки. Повторный клик по выбранной — снять выбор.
  selectTowerType(key) {
    if (this.selectedTower) this.closeTowerMenu();
    this.selectedTowerType = this.selectedTowerType === key ? null : key;
    this.refreshBuildMenu();
    if (!this.selectedTowerType) {
      this.cancelPlacement();
    } else if (this.input && this.input.activePointer) {
      const { gx, gy } = this.pointerToGrid(this.input.activePointer);
      this.updateGhost(gx, gy);
    }
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

  // Расположить кнопки панели постройки внизу экрана (компактно, без вылезания текста).
  layoutBuildMenu(width, height) {
    const keys = this.activeDeckKeys || Object.keys(this.buildButtons);
    const count = keys.length;
    if (count === 0) return;
    const gap = Math.min(8 * DPR, width * 0.015);
    const maxTotalW = width - 16 * DPR;
    const buttonWidth = Math.min(105 * DPR, Math.floor((maxTotalW - (count - 1) * gap) / count));
    this.buildButtonWidth = buttonWidth;
    this.buildGap = gap;

    const totalWidth = count * buttonWidth + (count - 1) * gap;
    const startX = width / 2 - totalWidth / 2 + buttonWidth / 2;
    const y = height - 56 * DPR;

    keys.forEach((key, index) => {
      const x = startX + index * (buttonWidth + gap);
      const b = this.buildButtons[key];
      if (!b) return;
      b.bg.setPosition(x, y);
      b.bg.setSize(buttonWidth, 86 * DPR);
      if (b.bg._roundItem) {
        b.bg._roundItem.w = buttonWidth;
        b.bg._roundItem.h = 86 * DPR;
      }
      b.iconBase.setPosition(x, y - 14 * DPR);
      if (b.iconWeapon) b.iconWeapon.setPosition(x, y - 14 * DPR);

      const maxTextW = Math.max(30, buttonWidth - 6 * DPR);
      let nameFs = Math.max(7 * DPR, Math.min(10.5 * DPR, Math.floor(buttonWidth * 0.155)));
      b.nameLabel.setPosition(x, y + 14 * DPR);
      b.nameLabel.setStyle({
        fontSize: `${nameFs}px`,
        wordWrap: { width: maxTextW, useAdvancedWrap: true },
      });
      while (nameFs > 6 * DPR && b.nameLabel.width > maxTextW) {
        nameFs -= 0.5 * DPR;
        b.nameLabel.setFontSize(`${nameFs}px`);
      }

      let costFs = Math.max(7.5 * DPR, Math.min(11 * DPR, Math.floor(buttonWidth * 0.165)));
      b.costLabel.setPosition(x, y + 27 * DPR);
      b.costLabel.setStyle({
        fontSize: `${costFs}px`,
      });
      while (costFs > 6.5 * DPR && b.costLabel.width > maxTextW) {
        costFs -= 0.5 * DPR;
        b.costLabel.setFontSize(`${costFs}px`);
      }
    });
    updateRoundBgs(this);
  }

  // Показать/скрыть панель постройки целиком (например, на экране поражения).
  setBuildMenuVisible(visible) {
    if (!this.buildButtons) return;
    for (const key in this.buildButtons) {
      const b = this.buildButtons[key];
      b.bg.setVisible(visible);
      b.iconBase.setVisible(visible);
      if (b.iconWeapon) b.iconWeapon.setVisible(visible);
      if (b.nameLabel) b.nameLabel.setVisible(visible);
      if (b.costLabel) b.costLabel.setVisible(visible);
    }
  }

  // ------------------------- Игровые события -------------------------
  // Враг убит башней — начисляем золото по типу врага.
  onEnemyKilled(enemy) {
    this.gold += enemy.reward;
    this.updateUI();

    // Обновляем прогресс квестов на убийства
    updateQuestProgress('kill', enemy.typeKey, 1);
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
      // Ставим детей позади родителя с ощутимым интервалом, чтобы не слипались.
      child.segment = parent.segment;
      child.progress = Math.max(0, parent.progress - i * 0.16);
      this.enemies.push(child);
    }
  }

  // Враг дошёл до базы — наносит урон, равный своему текущему остатку HP (+ щит).
  // Если врагу снесли здоровье почти до нуля (например, осталось 5 HP) — снимет только 5 HP.
  onEnemyReachedEnd(enemy) {
    if (this.isGameOver) return;
    if (this.infiniteLives) return; // чит: база бессмертна

    const rawDamage = (enemy ? enemy.hp : 0) + (enemy && enemy.shield ? enemy.shield : 0);
    const damage = Math.max(1, Math.round(rawDamage));

    this.lives = Math.max(0, this.lives - damage);
    this.updateUI();

    // Красный всплывающий урон на базе и лёгкая встряска экрана
    if (this.showFloatingText && enemy) {
      this.showFloatingText(enemy.x, enemy.y - 12 * DPR, `-${damage}`, 0xe74c3c);
    }
    if (this.cameras && this.cameras.main) {
      this.cameras.main.shake(100, 0.004);
    }

    console.log(`Враг нанёс ${damage} урона базе! Осталось HP базы: ${this.lives}`);

    if (this.lives <= 0) this.triggerGameOver();
  }

  // Останавливаем игру и показываем экран поражения.
  triggerGameOver() {
    if (this.isGameOver) return;

    this.isGameOver = true;
    if (this.gameOverText) {
      this.gameOverText.setText('ИГРА ОКОНЧЕНА');
      this.gameOverText.setColor('#e63946');
    }
    this.playSfx('sfx_gameover', 0.6);
    if (this.waveSpawnTimer) this.waveSpawnTimer.remove(false); // прекращаем спавн
    this.showGameOver();
    console.log('GAME OVER');

    // Отправляем рекорд в облако (не ждём ответа, чтобы игра не «зависла»).
    this.saveRecord();
  }

  // Победа: пройдены все волны выбранной сложности
  triggerVictory() {
    if (this.isGameOver) return;

    this.isGameOver = true;
    if (this.gameOverText) {
      this.gameOverText.setText('ПОБЕДА!');
      this.gameOverText.setColor('#2ecc71');
    }
    if (this.waveSpawnTimer) this.waveSpawnTimer.remove(false);
    this.showGameOver();

    const bonusXp = 200;
    savePlayerPassXp(getPlayerPassXp() + bonusXp);

    // Прогресс квеста на победу
    updateQuestProgress('victory', null, 1);

    this.showMessage(`Сектор зачищен! Все ${this.currentWave} волн пройдены! (+${bonusXp} XP Пасса)`);
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
    this.twoFingerGesture = false;

    // Состояние панорамирования одним пальцем.
    this.panArmed = false;
    this.panActive = false;
    this.panStart = { x: 0, y: 0 };
    this.panLast = { x: 0, y: 0 };

    const onPointerDownCheck = () => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1 && p2 && p1.isDown && p2.isDown) {
        this.twoFingerGesture = true;
        this.isPlacing = false;
        if (this.ghost) this.ghost.setVisible(false);
        this.clearRangeRing();
        this.pinchActive = false;
        this.pinchDistance = 0;
      }
    };
    this.input.on('pointerdown', onPointerDownCheck);

    this.input.on('pointermove', () => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;

      if (p1 && p2 && p1.isDown && p2.isDown) {
        this.twoFingerGesture = true;
        this.isPlacing = false;
        if (this.ghost) this.ghost.setVisible(false);
        this.clearRangeRing();

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
      if (!this.pinchActive && !this.twoFingerGesture) return;
      this.pinchActive = false;
      this.pinchDistance = 0;
      this.isPlacing = false;
      if (this.ghost) this.ghost.setVisible(false);
      if (!this.selectedTower && !this.isTowerViewMode) {
        this.clearRangeRing();
      }
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if ((!p1 || !p1.isDown) && (!p2 || !p2.isDown)) {
        setTimeout(() => {
          this.twoFingerGesture = false;
        }, 200);
      }
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
      if (!this.isTowerViewMode) {
        this.positionTowerMenu();
      } else {
        this.positionTowerViewPill();
      }
      this.showRangeRingForTower(this.selectedTower);
    }

    // Панель постройки башен.
    this.layoutBuildMenu(width, height);
    this.setBuildMenuVisible(!this.isGameOver);

    // Пересобираем скруглённые фоны кнопок.
    updateRoundBgs(this);
  }

  // Земля — большой изометрический ромб и возвышенные платформы (высотные позиции)
  drawGround() {
    const g = this.groundGraphics;
    g.clear();
    const corners = [
      worldToScreen(0, 0),
      worldToScreen(WORLD_SIZE, 0),
      worldToScreen(WORLD_SIZE, WORLD_SIZE),
      worldToScreen(0, WORLD_SIZE),
    ];
    const cellCol = (this.mapDef && this.mapDef.theme && this.mapDef.theme.cellColor) || CELL_COLOR;
    const gridCol = (this.mapDef && this.mapDef.theme && this.mapDef.theme.gridColor) || GRID_LINE_COLOR;
    g.fillStyle(cellCol, 1);
    g.fillPoints(corners, true);
    g.lineStyle(3, gridCol, 1);
    g.strokePoints(corners, true);

    // Отрисовка возвышенных платформ (3D изометрические подиумы)
    const elevations = (this.mapDef && this.mapDef.elevations) || [];
    const topCol = (this.mapDef && this.mapDef.theme && this.mapDef.theme.elevationTop) || 0x24324a;
    const sideCol = (this.mapDef && this.mapDef.theme && this.mapDef.theme.elevationSide) || 0x141d2c;
    const borderCol = (this.mapDef && this.mapDef.theme && this.mapDef.theme.elevationBorder) || 0x38bdf8;
    const liftY = 16; // изометрическая высота платформы в пикселях

    for (const el of elevations) {
      const p0 = worldToScreen(el.x, el.y);
      const p1 = worldToScreen(el.x + el.w, el.y);
      const p2 = worldToScreen(el.x + el.w, el.y + el.h);
      const p3 = worldToScreen(el.x, el.y + el.h);

      // Нижняя грань (тени/боковины)
      g.fillStyle(sideCol, 1);
      // Левая боковая грань (от p3 к p2 вниз)
      g.fillPoints([
        { x: p3.x, y: p3.y - liftY },
        { x: p2.x, y: p2.y - liftY },
        { x: p2.x, y: p2.y },
        { x: p3.x, y: p3.y },
      ], true);

      // Правая боковая грань (от p2 к p1 вниз)
      g.fillPoints([
        { x: p2.x, y: p2.y - liftY },
        { x: p1.x, y: p1.y - liftY },
        { x: p1.x, y: p1.y },
        { x: p2.x, y: p2.y },
      ], true);

      // Верхняя площадка платформы (поднята на liftY)
      const topPts = [
        { x: p0.x, y: p0.y - liftY },
        { x: p1.x, y: p1.y - liftY },
        { x: p2.x, y: p2.y - liftY },
        { x: p3.x, y: p3.y - liftY },
      ];
      g.fillStyle(topCol, 0.96);
      g.fillPoints(topPts, true);

      // Неоновый технологический кант возвышенности
      g.lineStyle(2, borderCol, 0.9);
      g.strokePoints(topPts, true);
    }
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
    const roadCol = (this.mapDef && this.mapDef.theme && this.mapDef.theme.roadColor) || ROAD_COLOR;
    g.fillStyle(roadCol, 1);
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

    const base = this.resolveBase(tower.typeKey, tower.baseDir, tower.level);
    if (base) {
      tower.baseSprite = this.add.image(pos.x, pos.y, base.key).setDepth(depth);
      this.applyBaseVisual(tower.baseSprite, tower.typeKey, base, tower.level);
    }

    const gun = this.resolveGun(tower.typeKey, tower.level, tower.aimDir);
    if (gun) {
      tower.sprite = this.add.image(pos.x, pos.y, gun.key).setDepth(depth + 0.05);
      this.applyGunVisual(tower.sprite, tower.typeKey, gun, tower.level);
    }

    this.applyTowerFacing(tower);
  }

  // Переключаем текстуры корпуса/крепления и пушки по их ТЕКУЩИМ направлениям
  // (крепление и пушка поворачиваются независимо). Направленные спрайты НЕ вращаем.
  applyTowerFacing(tower) {
    const pos = tower.getPosition();
    const type = tower.config;
    // Спрайт поднят над клеткой визуально (тап-зона — на клетке).
    const baseY = pos.y - BASE_LIFT * this.cellSize;

    // Центр башни (вокруг него облетает пушка) — центр РИСУНКА корпуса/крепления.
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
      const base = this.resolveBase(tower.typeKey, tower.baseDir, tower.level);
      if (base) {
        if (tower.baseSprite.texture.key !== base.key) {
          tower.baseSprite.setTexture(base.key);
          this.applyBaseVisual(tower.baseSprite, tower.typeKey, base, tower.level);
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
        const baseDepth = 10 + (tower.gx + tower.gy) * 0.01;
        if (gun.directional) {
          // Пушка облетает ЦЕНТР башни в сторону цели (для человека с оружием).
          // Для стационарной установки (arc) пулемёт сидит ровно на станке/креплении (orbit = 0).
          const lvl = type.levels && type.levels[tower.level - 1];
          const defaultOrbit = tower.arc ? 0 : (type.gunOrbit || 0);
          const orbitVal = lvl && lvl.gunOrbit !== undefined ? lvl.gunOrbit : defaultOrbit;
          const orbit = orbitVal * this.cellSize;
          const orbitX = orbit * (type.gunOrbitX || 1); // растяжение по горизонтали
          const orbitY = orbit * (type.gunOrbitY || 1); // сжатие по вертикали
          const mount = (lvl && lvl.gunMount) || type.gunMount || { x: 0, y: 0 };
          const p = ellipseArcPoint(tower.aimAngle, orbitX, orbitY); // ровная скорость
          const gunX = centerX + p.x + mount.x * this.cellSize;
          const gunY = centerY + p.y + mount.y * this.cellSize;
          tower.sprite.setPosition(gunX, gunY);
          tower.sprite.setRotation(0);
          if (tower.arc) {
            // У установки пулемёт всегда сверху станины/крепления
            tower.sprite.setDepth(baseDepth + 0.05);
          } else {
            // За спиной — когда пушка смотрит наверх (в дальнюю от камеры сторону).
            const behind = Math.sin(tower.aimAngle) < -0.05;
            tower.sprite.setDepth(behind ? baseDepth - 0.05 : baseDepth + 0.05);
          }
        } else {
          tower.sprite.setPosition(centerX, centerY);
          tower.sprite.setRotation(tower.aimAngle);
          tower.sprite.setDepth(baseDepth + 0.05);
        }
      }
    }
  }

  // Меняем пушку и корпус/крепление башни (после улучшения уровня).
  refreshTowerSprite(tower) {
    const base = this.resolveBase(tower.typeKey, tower.baseDir, tower.level);
    if (!base) {
      if (tower.baseSprite) {
        tower.baseSprite.destroy();
        tower.baseSprite = null;
      }
    } else if (!tower.baseSprite) {
      const pos = tower.getPosition();
      const depth = 10 + (tower.gx + tower.gy) * 0.01;
      tower.baseSprite = this.add.image(pos.x, pos.y, base.key).setDepth(depth);
      this.applyBaseVisual(tower.baseSprite, tower.typeKey, base, tower.level);
    } else {
      if (tower.baseSprite.texture.key !== base.key) {
        tower.baseSprite.setTexture(base.key);
        this.applyBaseVisual(tower.baseSprite, tower.typeKey, base, tower.level);
      }
    }

    const gun = this.resolveGun(tower.typeKey, tower.level, tower.aimDir);
    if (!gun) {
      if (tower.sprite) {
        tower.sprite.destroy();
        tower.sprite = null;
      }
    } else if (!tower.sprite) {
      const pos = tower.getPosition();
      const depth = 10 + (tower.gx + tower.gy) * 0.01 + 0.05;
      tower.sprite = this.add.image(pos.x, pos.y, gun.key).setDepth(depth);
      this.applyGunVisual(tower.sprite, tower.typeKey, gun, tower.level);
    } else {
      if (tower.sprite.texture.key !== gun.key) {
        tower.sprite.setTexture(gun.key);
        this.applyGunVisual(tower.sprite, tower.typeKey, gun, tower.level);
      }
    }

    this.applyTowerFacing(tower);
  }

  // Ключ корпуса/крепления:
  // 1. Уровневое крепление (для установок/моделей конкретного уровня):
  //    "<type>_base_<level>_<dir>", "<type>_mount_<level>_<dir>", "<type>_mount_<dir>"
  // 2. Стандартный направленный: "<type>_base_<dir>"
  // 3. Старый: "<type>_base"
  // 4. Шаблон: "template_base_<dir>"
  // 5. Запасная картинка типа
  resolveBase(typeKey, dir, level = 1) {
    if (level) {
      const levelDirKey = `${typeKey}_base_${level}_${dir}`;
      if (this.textures.exists(levelDirKey)) return { key: levelDirKey, directional: true };

      const mountLevelDirKey = `${typeKey}_mount_${level}_${dir}`;
      if (this.textures.exists(mountLevelDirKey)) return { key: mountLevelDirKey, directional: true };

      const mountDirKey = `${typeKey}_mount_${dir}`;
      if (this.textures.exists(mountDirKey)) return { key: mountDirKey, directional: true };

      const levelKey = `${typeKey}_base_${level}`;
      if (this.textures.exists(levelKey)) return { key: levelKey, directional: false };

      const mountLevelKey = `${typeKey}_mount_${level}`;
      if (this.textures.exists(mountLevelKey)) return { key: mountLevelKey, directional: false };

      const mountKey = `${typeKey}_mount`;
      if (this.textures.exists(mountKey)) return { key: mountKey, directional: false };
    }

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

  // Вписываем корпус/крепление: направленный — фиксированная опора,
  // старый — авто-центр по непрозрачной части (как раньше).
  applyBaseVisual(image, typeKey, base, level = 1) {
    const type = TOWER_TYPES[typeKey];
    const contentPx = this.cellSize * type.footprint;
    if (base.directional) {
      const o = type.baseOrigin || { x: 0.5, y: 1.0 };
      this.applyDirectionalVisual(image, base.key, contentPx, o.x, o.y, `${typeKey}_base_${level}`);
    } else {
      this.applyTowerVisual(image, base.key, type.footprint);
    }
    const skin = getEquippedTowerSkin(typeKey);
    if (skin && skin.tint !== null && skin.tint !== undefined) {
      image.setTint(skin.tint);
    } else {
      image.clearTint();
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
  showRangeRing(x, y, rangeUnits, color, footprintUnits, arc = null, mountAngle = 0, tower = null) {
    this.rangeGraphics.clear();
    if (footprintUnits) {
      this.fillIsoEllipse(x, y, footprintUnits, 0xffffff, 0.06);
      this.strokeIsoEllipse(x, y, footprintUnits, 0xffffff, 0.5, 2);
    }
    const a = ISO_HW * Math.SQRT2 * rangeUnits;
    const b = ISO_HH * Math.SQRT2 * rangeUnits;
    const g = this.rangeGraphics;
    if (arc) {
      const startAngle = mountAngle - arc / 2;
      g.fillStyle(0xffffff, 0.05);
      g.beginPath();
      g.moveTo(x, y);
      const SECTOR_STEPS = 32;
      for (let i = 0; i <= SECTOR_STEPS; i++) {
        const ang = startAngle + (arc * i) / SECTOR_STEPS;
        g.lineTo(x + Math.cos(ang) * a, y + Math.sin(ang) * b);
      }
      g.closePath();
      g.fillPath();
    } else {
      this.fillIsoEllipse(x, y, rangeUnits, 0xffffff, 0.04);
    }
    this.activeRange = { x: x, y: y, r: rangeUnits, arc: arc, mountAngle: mountAngle, tower: tower };
  }

  // Кольца конкретной башни (радиус атаки + её площадь или сектор).
  showRangeRingForTower(tower) {
    const pos = tower.getPosition();
    this.showRangeRing(
      pos.x,
      pos.y,
      tower.range,
      tower.config.color,
      tower.config.footprint / 2,
      tower.arc,
      tower.mountAngle || 0,
      tower
    );
  }

  // Белая пунктирная вращающаяся грань радиуса атаки + калибровочные кольца и баллистический конус
  drawDashedRangeRing() {
    const g = this.rangeDashGraphics;
    if (!g) return;
    g.clear();
    const ar = this.activeRange;
    if (!ar) return;

    const cx = ar.x;
    const cy = ar.y;
    const a = ISO_HW * Math.SQRT2 * ar.r;
    const b = ISO_HH * Math.SQRT2 * ar.r;



    // 2. Внешняя вращающаяся грань дальности (100%)
    g.lineStyle(3, 0xffffff, 0.9);

    if (ar.arc) {
      const startAngle = ar.mountAngle - ar.arc / 2;
      const endAngle = ar.mountAngle + ar.arc / 2;

      // Ограничительные лучи сектора обстрела
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(startAngle) * a, cy + Math.sin(startAngle) * b);
      g.strokePath();

      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(endAngle) * a, cy + Math.sin(endAngle) * b);
      g.strokePath();

      // Пунктирная дуга сектора
      const ARC_DASHES = 10;
      const DASH_FRAC = 0.55;
      const step = ar.arc / ARC_DASHES;
      const SEG = 4;
      for (let i = 0; i < ARC_DASHES; i++) {
        const start = startAngle + i * step;
        const end = start + step * DASH_FRAC;
        g.beginPath();
        for (let j = 0; j <= SEG; j++) {
          const t = start + (end - start) * (j / SEG);
          const px = cx + Math.cos(t) * a;
          const py = cy + Math.sin(t) * b;
          if (j === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.strokePath();
      }
    } else {
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
          const px = cx + Math.cos(t) * a;
          const py = cy + Math.sin(t) * b;
          if (j === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.strokePath();
      }
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
    const diffHpMult = (this.diffDef && this.diffDef.hpMultiplier) || 1.0;
    return (1 + (wave - 1) * ENEMY_HP_SCALE) * diffHpMult;
  }

  // Составляем очередь типов врагов для волны.
  buildWaveComposition(wave) {
    const counts =
      wave <= WAVE_TABLE.length ? { ...WAVE_TABLE[wave - 1] } : this.buildEndlessWave(wave);

    // Боссов выпускаем в конце, чтобы остальные успели создать давление.
    const bossCount = counts.boss || 0;
    delete counts.boss;

    // Группируем врагов пачками (по 3-4 одного типа),
    // чтобы враги одинаковой скорости шли отрядом и держали постоянную дистанцию,
    // а не перемешивались по 1 штуке (когда быстрый сразу втыкается в спину медленному).
    const squadSize = 4;
    const entries = Object.entries(counts).filter(([_, n]) => n > 0);
    const queue = [];
    let added = true;
    while (added) {
      added = false;
      for (const entry of entries) {
        if (entry[1] > 0) {
          const take = Math.min(entry[1], squadSize);
          for (let k = 0; k < take; k++) {
            queue.push(entry[0]);
          }
          entry[1] -= take;
          added = true;
        }
      }
    }

    for (let i = 0; i < bossCount; i++) queue.push('boss');
    return queue;
  }

  // Волны после завершения таблицы: плавный рост количества и смешивание типов.
  buildEndlessWave(wave) {
    const step = wave - WAVE_TABLE.length;
    const scale = 1 + step * 0.15;
    const counts = {
      normal: Math.round(20 * scale),
      fast: Math.round(12 * scale),
      armored: Math.round(10 * scale),
      stalker: Math.round(8 * scale),
      regenerator: Math.round(6 * scale),
      tank: Math.round(5 * scale),
      splitter: Math.round(6 * scale),
      shielded: Math.round(8 * scale),
    };
    if (wave % 10 === 0) counts.boss = Math.max(1, Math.floor(step / 10) + 1);
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

    // Прогресс квеста на достижение волны
    updateQuestProgress('wave_start', this.currentWave, 1);

    // Первый враг выходит через небольшую паузу (500мс)
    if (this.waveSpawnTimer) {
      this.waveSpawnTimer.remove(false);
      this.waveSpawnTimer = null;
    }
    this.waveSpawnTimer = this.time.delayedCall(500, this.spawnWaveEnemy, [], this);
  }

  // Выпускаем одного врага текущей волны и планируем спавн следующего по физической дистанции.
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

    // Если враги ещё остались — рассчитываем паузу до следующего спавна по дистанции в клетках.
    if (this.enemiesLeftToSpawn > 0) {
      // Базовая дистанция в клетках (от 3.2 на 1-й волне до 2.2 на поздних).
      const gapTiles = Math.max(
        SPAWN_GAP_TILES_MIN,
        SPAWN_GAP_TILES_BASE - (this.currentWave - 1) * 0.04
      );

      let dist = gapTiles;

      // Если следующий враг в очереди быстрее текущего (например, fast за armored/tank),
      // даём дополнительный зазор (+1.2 клетки), чтобы быстрый не догнал медленного сходу.
      const nextType = this.waveQueue[0];
      const nextBase = nextType ? ENEMY_TYPES[nextType] : null;
      if (nextBase && nextBase.speed > base.speed) {
        dist += 1.2;
      }

      // Для босса даём увеличенное пространство
      if (typeKey === 'boss') {
        dist += 1.0;
      }

      // Время в мс, за которое только что вышедший враг отойдёт на dist клеток
      const delayMs = Math.round((dist / base.speed) * 1000);
      this.waveSpawnTimer = this.time.delayedCall(delayMs, this.spawnWaveEnemy, [], this);
    } else {
      // Все враги выпущены — таймер порционного спавна больше не нужен.
      if (this.waveSpawnTimer) {
        this.waveSpawnTimer.remove(false);
        this.waveSpawnTimer = null;
      }
    }
  }

  // Волна завершена, если все враги выпущены и на поле никого живого нет.
  checkWaveEnd() {
    if (!this.isWaveActive || this.enemiesLeftToSpawn > 0) return;

    const alive = this.enemies.some((enemy) => enemy.active && !enemy.isDead && !enemy.isCured);
    if (alive) return;

    this.endWave();
  }

  // Завершаем волну: начисляем бонус и возвращаем кнопку старта (или объявляем победу).
  endWave() {
    this.isWaveActive = false;
    const clearBonus = Math.round(WAVE_CLEAR_BONUS + this.currentWave * 4);
    this.gold += clearBonus;
    this.updateUI();

    // Прогресс квестов на отражение волн
    updateQuestProgress('wave_clear', null, 1);

    const xpPerWave = (this.diffDef && this.diffDef.passXpPerWave)
      ? this.diffDef.passXpPerWave
      : (this.selectedDifficulty === 'hard' ? 60 : this.selectedDifficulty === 'easy' ? 25 : 40);
    savePlayerPassXp(getPlayerPassXp() + xpPerWave);

    const maxWaves = (this.diffDef && this.diffDef.totalWaves) || 20;
    if (this.currentWave >= maxWaves) {
      this.triggerVictory();
      return;
    }

    this.startButton.setVisible(true);
    this.showMessage(`Волна ${this.currentWave} зачищена! +${clearBonus} 🟡 | +${xpPerWave} XP Пасса`);

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
      if (tower.baseSprite && Phaser.Geom.Rectangle.Contains(tower.baseSprite.getBounds(), px, py)) {
        return tower;
      }
      if (tower.sprite && Phaser.Geom.Rectangle.Contains(tower.sprite.getBounds(), px, py)) {
        return tower;
      }
      const p = tower.getPosition();
      const hitRadius = (tower.config.footprint / 2 + 0.35) * this.cellSize;
      if (Math.hypot(px - p.x, (py - p.y) * 2) < hitRadius) {
        return tower;
      }
    }
    return null;
  }

  // Находится ли точка (gx, gy) на возвышенности текущей карты
  isOnElevation(gx, gy, radius = 0.3) {
    const elevations = (this.mapDef && this.mapDef.elevations) || [];
    for (const el of elevations) {
      if (
        gx >= el.x &&
        gx <= el.x + el.w &&
        gy >= el.y &&
        gy <= el.y + el.h
      ) {
        return true;
      }
    }
    return false;
  }

  // Можно ли поставить башню типа type в точку:
  // в пределах поля, не на дороге, не пересекаясь с другими башнями,
  // а для снайпера — СТРОГО на возвышенности.
  // Пересекает ли башня (gx, gy, radius) возвышенность/крышу текущей карты
  isOverElevation(gx, gy, radius = 0.3) {
    const elevations = (this.mapDef && this.mapDef.elevations) || [];
    for (const el of elevations) {
      const closestX = Math.max(el.x, Math.min(gx, el.x + el.w));
      const closestY = Math.max(el.y, Math.min(gy, el.y + el.h));
      const dx = gx - closestX;
      const dy = gy - closestY;
      if (dx * dx + dy * dy < radius * radius) {
        return true;
      }
    }
    return false;
  }

  isFreeSpot(gx, gy, type, ignoreTower = null) {
    const radius = type.footprint / 2;

    // Границы мира.
    if (gx - radius < 0 || gx + radius > WORLD_SIZE) return false;
    if (gy - radius < 0 || gy + radius > WORLD_SIZE) return false;

    // Снайпер: может стоять ТОЛЬКО на возвышенностях
    if (type.onlyElevation && !this.isOnElevation(gx, gy, radius)) {
      return false;
    }

    // Башни помимо снайпера нельзя размещать на крышах / возвышенностях
    if (!type.onlyElevation && this.isOverElevation(gx, gy, radius)) {
      return false;
    }

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

    // Если сейчас режим наведения сектора установки:
    if (this.aimingTower) {
      const pos = this.aimingTower.getPosition();
      const angle = Math.atan2((worldPx.y - pos.y) / ISO_HH, (worldPx.x - pos.x) / ISO_HW);
      this.aimingTower.setMountAngle(angle);
      this.applyTowerFacing(this.aimingTower);
      this.showRangeRingForTower(this.aimingTower);
      return;
    }

    // Нажали на башню — открываем её меню или переключаем режим просмотра.
    const existing = this.towerAt(worldPx.x, worldPx.y);
    if (existing) {
      if (this.selectedTowerType) {
        this.selectedTowerType = null;
        this.refreshBuildMenu();
      }
      if (this.ghost) this.ghost.setVisible(false);
      this.isPlacing = false;
      if (this.selectedTower === existing) {
        if (this.canUseTowerViewMode()) {
          if (this.isTowerViewMode) {
            this.exitTowerViewMode(true);
          } else {
            this.enterTowerViewMode();
          }
        }
        return;
      }
      this.isTowerViewMode = false;
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

    // Если сейчас был активен режим просмотра: помечаем, что нажали на пустое поле
    if (this.isTowerViewMode) {
      this.viewModeTappedGround = true;
      this.panArmed = true;
      this.panStart.x = pointer.x;
      this.panStart.y = pointer.y;
      return;
    }

    // Клик по пустому месту — закрываем меню.
    this.closeTowerMenu();
    // Пустое место: разрешаем панорамирование одним пальцем/мышью ТОЛЬКО если башня НЕ выбрана.
    // При выборе башни карту нельзя двигать одним пальцем.
    if (!this.selectedTowerType) {
      this.panArmed = true;
      this.panStart.x = pointer.x;
      this.panStart.y = pointer.y;
      return;
    }

    // Если активен жест двумя пальцами — башня не размещается и призрак скрыт
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;
    if (this.twoFingerGesture || this.pinchActive || (p1 && p2 && p1.isDown && p2.isDown)) {
      this.twoFingerGesture = true;
      this.isPlacing = false;
      if (this.ghost) this.ghost.setVisible(false);
      this.clearRangeRing();
      return;
    }

    this.panArmed = false;
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

    if (type.onlyElevation && !this.isOnElevation(gx, gy, type.footprint / 2)) {
      this.showMessage('Снайпер устанавливается ТОЛЬКО на возвышенности!');
      return false;
    }

    if (!type.onlyElevation && this.isOverElevation(gx, gy, type.footprint / 2)) {
      this.showMessage('На крышах можно ставить ТОЛЬКО снайперов!');
      return false;
    }

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

    // Прогресс квестов на постройку
    updateQuestProgress('build', this.selectedTowerType, 1);
    return true;
  }

  // Показываем «призрак» башни под указателем: зелёный — можно, красный — нельзя.
  updateGhost(gx, gy) {
    // ВАЖНО (Требование 4): если двигают двумя пальцами, башня не размещается и призрак скрыт
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;
    if (this.twoFingerGesture || this.pinchActive || (p1 && p2 && p1.isDown && p2.isDown)) {
      if (this.ghost) this.ghost.setVisible(false);
      this.clearRangeRing();
      return;
    }

    // Если открыто меню башни — призрак не показываем (кольцо уже от меню).
    if (this.selectedTower || this.isTowerViewMode) {
      if (this.ghost) this.ghost.setVisible(false);
      return;
    }

    const type = this.selectedTowerType ? TOWER_TYPES[this.selectedTowerType] : null;
    const inside = gx >= 0 && gx <= WORLD_SIZE && gy >= 0 && gy <= WORLD_SIZE;

    if (!type || !inside || this.isGameOver) {
      if (this.ghost) this.ghost.setVisible(false);
      if (!this.selectedTower && !this.isTowerViewMode) {
        this.clearRangeRing();
      }
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
    this.activeRange = {
      x: pos.x,
      y: pos.y,
      r: type.range,
      tower: {
        aimAngle: dirToAngle(DIR_FORWARD),
        accuracy: type.accuracy !== undefined ? type.accuracy : 1.0,
        sprayCone: type.sprayCone || null,
      },
    };
  }

  // Движение указателя: показываем призрак будущей башни.
  handlePointerMove(pointer) {
    if (this.isGameOver) return;

    // ВАЖНО (Требование 4): если двигают двумя пальцами — башня не размещается, призрак скрыт!
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;
    if (this.twoFingerGesture || this.pinchActive || (p1 && p2 && p1.isDown && p2.isDown)) {
      this.isPlacing = false;
      if (this.ghost) this.ghost.setVisible(false);
      this.clearRangeRing();
      return;
    }

    // Режим наведения сектора установки:
    if (this.aimingTower && pointer.isDown) {
      const worldPx = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const pos = this.aimingTower.getPosition();
      const angle = Math.atan2((worldPx.y - pos.y) / ISO_HH, (worldPx.x - pos.x) / ISO_HW);
      this.aimingTower.setMountAngle(angle);
      this.applyTowerFacing(this.aimingTower);
      this.showRangeRingForTower(this.aimingTower);
      return;
    }

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
    // ВАЖНО (Требование 4): при выборе башни карту нельзя двигать одним пальцем!
    if (this.selectedTowerType) {
      return false;
    }
    if (!this.panArmed || this.pinchActive || this.twoFingerGesture) {
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
      this.viewModeTappedGround = false;
      if (this.isPlacing) {
        this.isPlacing = false;
        if (this.ghost) this.ghost.setVisible(false);
      }
      if (!this.isTowerViewMode && !this.selectedTower) {
        this.clearRangeRing();
      }
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
    // ВАЖНО (Требование 4): если был жест двумя пальцами — башня НЕ размещается!
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;
    if (this.twoFingerGesture || this.pinchActive) {
      this.isPlacing = false;
      this.panArmed = false;
      this.panActive = false;
      if (this.ghost) this.ghost.setVisible(false);
      if (!this.selectedTower && !this.isTowerViewMode) {
        this.clearRangeRing();
      }
      if ((!p1 || !p1.isDown) && (!p2 || !p2.isDown)) {
        setTimeout(() => {
          this.twoFingerGesture = false;
        }, 200);
      }
      return;
    }

    // Сбрасываем панорамирование. Если панорамировали — тап не выполняем.
    const wasPanning = this.panActive;
    this.panArmed = false;
    this.panActive = false;

    // Если был потяг (панорамирование) — это не тап, ничего не строим.
    if (wasPanning) {
      this.viewModeTappedGround = false;
      return;
    }

    // Одиночный клик по пустому полю во время режима просмотра — закрываем его.
    if (this.isTowerViewMode && this.viewModeTappedGround) {
      this.viewModeTappedGround = false;
      this.closeTowerMenu();
      return;
    }
    this.viewModeTappedGround = false;

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
  roundPixels: true,
  render: {
    antialias: true,
    roundPixels: true,
    // Мипмапы убирают «мыло» при уменьшении спрайтов (важно на телефоне).
    mipmapFilter: 'LINEAR_MIPMAP_LINEAR',
    powerPreference: 'high-performance',
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
window.__sporeGame = game;

// Держим канвас в физическом разрешении экрана и пересобираем при ресайзе.
function applyCanvasSize() {
  if (!game.scale || !game.scale.canvas) return;
  game.scale.resize(window.innerWidth * DPR, window.innerHeight * DPR);
}
window.addEventListener('resize', applyCanvasSize);
window.addEventListener('orientationchange', () => setTimeout(applyCanvasSize, 200));
game.events.once('ready', applyCanvasSize);
applyCanvasSize();
