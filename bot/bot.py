# -*- coding: utf-8 -*-
"""Telegram-бот игры Tower Defense: таблица лидеров, роли и личный рекорд.

Работает в двух режимах:
  * локально:  python bot.py              (токен и ключ из config.py/service-account.json)
  * в облаке (GitHub Actions): всё берётся из переменных окружения

Роли хранятся в Firestore (коллекция "users"). Запись идёт через сервисный
аккаунт (Firebase Admin), поэтому правила Firestore клиентам писать запрещают.
"""

import base64
import json
import os
import random
import re
import time

import requests
import urllib3.util.connection as urllib_conn

# Отключаем IPv6 для urllib3/requests на системах с отключённым IPv6 в ядре (предотвращает [Errno 99])
urllib_conn.HAS_IPV6 = False

BOT_USERNAME = "SporeTDBot"

try:
    import firebase_admin
    from firebase_admin import credentials, firestore

    FIREBASE_ADMIN_AVAILABLE = True
except ImportError:
    FIREBASE_ADMIN_AVAILABLE = False

BOT_TOKEN = os.environ.get("BOT_TOKEN")
CREATOR_ID = os.environ.get("CREATOR_ID")
PROJECT_ID = "telegram-tower-defense"
API_KEY = "AIzaSyDSIr6tflEu5cYQNXexM0co5hqkDXMVd8Y"
SA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "service-account.json")
SA_B64 = os.environ.get("FIREBASE_SERVICE_ACCOUNT")

# Локальный config.py (не попадает в Git) может переопределить настройки.
try:
    import config

    BOT_TOKEN = BOT_TOKEN or getattr(config, "BOT_TOKEN", None)
    CREATOR_ID = CREATOR_ID or getattr(config, "CREATOR_ID", None)
    PROJECT_ID = getattr(config, "PROJECT_ID", PROJECT_ID)
    API_KEY = getattr(config, "API_KEY", API_KEY)
except ImportError:
    pass

if not BOT_TOKEN:
    raise SystemExit("Не задан BOT_TOKEN (переменная окружения BOT_TOKEN или config.py).")

API = f"https://api.telegram.org/bot{BOT_TOKEN}"
FIRESTORE_URL = (
    f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}"
    f"/databases/(default)/documents/leaderboard?key={API_KEY}"
)

TOP_BUTTON = "🏆 Топ-10"
ME_BUTTON = "📊 Мой рекорд"
SETTINGS_BUTTON = "⚙ Настройки"
HELP_BUTTON = "❓ Помощь"
UNITY_BUTTON = "🧪 Тест (Vercel)"
GAME_URL = "https://gyviii-1.github.io/spore-tower-defense/unity/"
UNITY_URL = "https://telegram-tower-defense-git-beta-gyviii.vercel.app/unity/"
BETA_URL = "https://telegram-tower-defense-git-beta-gyviii.vercel.app/unity/"
MENU_KEYBOARD = {
    "keyboard": [
        [{"text": TOP_BUTTON}, {"text": ME_BUTTON}],
        [{"text": SETTINGS_BUTTON}, {"text": HELP_BUTTON}],
    ],
    "resize_keyboard": True,
}
CURRENT_KEYBOARD = MENU_KEYBOARD


def menu_keyboard(role):
    """Клавиатура внизу. Создателю/тестерам добавляем кнопку тестовой версии."""
    rows = [
        [{"text": TOP_BUTTON}, {"text": ME_BUTTON}],
        [{"text": SETTINGS_BUTTON}, {"text": HELP_BUTTON}],
    ]
    if role in ("creator", "tester"):
        rows.append([
            {"text": UNITY_BUTTON, "web_app": {"url": UNITY_URL}},
        ])
    return {"keyboard": rows, "resize_keyboard": True}

TOP_LIMIT = 10
PAGE_SIZE = 10
ROLE_LABELS = {"creator": "создатель", "tester": "тестер", "vip": "VIP", "player": ""}

# Состояние диалогов с создателем (по chat_id).
search_pending = {}
search_query = {}

# --------------------------- Firebase Admin ---------------------------
db = None


def init_firebase():
    """Подключаем Firebase Admin (сервисный аккаунт) — для чтения и записи ролей."""
    global db
    if not FIREBASE_ADMIN_AVAILABLE:
        print("[WARN] firebase-admin не установлен — роли недоступны.")
        return

    try:
        if firebase_admin._apps:
            db = firestore.client()
            return
    except Exception:
        pass

    try:
        if os.path.exists(SA_PATH):
            cred = credentials.Certificate(SA_PATH)
        elif SA_B64:
            cred = credentials.Certificate(json.loads(base64.b64decode(SA_B64)))
        else:
            print("[WARN] Нет ключа сервисного аккаунта — роли недоступны.")
            return

        firebase_admin.initialize_app(cred)
        db = firestore.client()
        print("[INFO] Firebase Admin подключён.")
    except Exception as error:
        print("[ERROR] Firebase Admin:", error)


# ----------------------------- Telegram API -----------------------------
SESSION_UPDATES = requests.Session()
SESSION_API = requests.Session()

def api(method, **params):
    """Вызов метода Telegram Bot API с постоянными keep-alive сессиями."""
    global SESSION_UPDATES, SESSION_API
    sess = SESSION_UPDATES if method == "getUpdates" else SESSION_API
    timeout = 25 if method == "getUpdates" else 15
    try:
        response = sess.post(f"{API}/{method}", json=params, timeout=timeout)
        return response.json()
    except Exception as e:
        print(f"[API ERROR] {method}: {e}")
        try:
            if method == "getUpdates":
                SESSION_UPDATES.close()
                SESSION_UPDATES = requests.Session()
            else:
                SESSION_API.close()
                SESSION_API = requests.Session()
        except Exception:
            pass
        return {"ok": False, "description": str(e)}


def send_message(chat_id, text, markdown=True, keyboard=None):
    payload = {
        "chat_id": chat_id,
        "text": text,
        "reply_markup": keyboard if keyboard is not None else CURRENT_KEYBOARD,
    }
    if markdown:
        payload["parse_mode"] = "Markdown"
    res = api("sendMessage", **payload)
    if not res.get("ok"):
        desc = res.get("description", "").lower()
        if "can't parse entities" in desc:
            payload.pop("parse_mode", None)
            res = api("sendMessage", **payload)
    return res


# ------------------------------- Роли -------------------------------
def user_nick(message):
    """Ник игрока из профиля Telegram."""
    user = message.get("from", {})
    if user.get("username"):
        return "@" + user["username"]
    name = " ".join(filter(None, [user.get("first_name"), user.get("last_name")]))
    return name or "Игрок"


def ensure_user(user_id, nick, username):
    """Заводим/обновляем пользователя. Роль по умолчанию — player."""
    if db is None:
        return
    ref = db.collection("users").document(str(user_id))
    snapshot = ref.get()
    is_creator = str(user_id) == str(CREATOR_ID)

    if not snapshot.exists:
        data = {
            "nick": nick,
            "role": "creator" if is_creator else "player",
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if username:
            data["username"] = username.lower()
        ref.set(data)
    else:
        update = {"nick": nick, "updatedAt": firestore.SERVER_TIMESTAMP}
        if username:
            update["username"] = username.lower()
        if is_creator:
            update["role"] = "creator"
        ref.set(update, merge=True)


def set_role(user_id, role):
    """Выдать роль пользователю (создаёт документ, если его нет)."""
    if db is None:
        return False
    db.collection("users").document(str(user_id)).set(
        {"role": role, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
    )
    return True


def set_ban(user_id, value):
    """Забанить/разбанить пользователя."""
    if db is None:
        return False
    db.collection("users").document(str(user_id)).set(
        {"banned": bool(value), "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
    )
    return True


def toggle_ban(user_id):
    """Переключает бан. Возвращает новое значение или None."""
    if db is None:
        return None
    ref = db.collection("users").document(str(user_id))
    snap = ref.get()
    current = bool(snap.to_dict().get("banned")) if snap.exists else False
    ref.set({"banned": not current, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return not current


def is_username_banned(username):
    """Забанен ли @username (срабатывает даже до первого входа в бота)."""
    if db is None or not username:
        return False
    try:
        return db.collection("banned_usernames").document(username.lstrip("@").lower()).get().exists
    except Exception as error:
        print("Ошибка чтения бан-ников:", error)
        return False


def set_username_ban(username, value):
    """Добавить/убрать @username в список бан-ников."""
    if db is None or not username:
        return False
    ref = db.collection("banned_usernames").document(username.lstrip("@").lower())
    if value:
        ref.set({"banned": True, "updatedAt": firestore.SERVER_TIMESTAMP})
    else:
        ref.delete()
    return True


def resolve_target(target):
    """Находит игрока по @username или числовому ID. Возвращает (doc_id, ошибка)."""
    if db is None:
        return None, "Роли недоступны (нет ключа сервисного аккаунта)."

    target = (target or "").strip()
    if target.startswith("@"):
        target = target[1:]

    if target.isdigit():
        return target, None
    if not target:
        return None, "Не указан пользователь."

    docs = db.collection("users").where("username", "==", target.lower()).limit(1).stream()
    for document in docs:
        return document.id, None

    return None, (
        "Не нашёл такого пользователя. Пусть он сначала напишет боту /start, "
        "или укажи числовой ID."
    )


def get_user_data(user_id):
    """Данные пользователя из Firestore (роль, скрыт и т.д.)."""
    if db is None:
        return {}
    snapshot = db.collection("users").document(str(user_id)).get()
    return snapshot.to_dict() if snapshot.exists else {}


def settings_text(user_id):
    hidden = "Да" if get_user_data(user_id).get("hidden") else "Нет"
    return f"⚙ Настройки\n\nСкрыт из списка: {hidden}"


def settings_keyboard(user_id):
    hidden = bool(get_user_data(user_id).get("hidden"))
    label = "Показать в списке" if hidden else "Скрыть из списка"
    return {"inline_keyboard": [[{"text": label, "callback_data": "toggle_hidden"}]]}


def toggle_hidden(user_id):
    """Переключает «скрыт из списка». Возвращает новое значение или None."""
    if db is None:
        return None
    new_value = not bool(get_user_data(user_id).get("hidden"))
    db.collection("users").document(str(user_id)).set(
        {"hidden": new_value, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
    )
    return new_value


def commands_text(role):
    """Список доступных команд с учётом роли."""
    lines = [
        "📋 *Команды бота*",
        "",
        "🎮 *Игра Spore Tower Defense:*",
        "• Играть — кнопка «Играть» слева внизу",
        "• Топ-10 и личный рекорд — кнопки меню внизу",
        "• /whoami — мой ID и статус",
        "• /settings — настройки профиля",
        "• /help — эта справка",
        "",
        "🛡 *Модерация чата (в группах):*",
        "• !мут [время] [причина] — ограничить отправку сообщений (ответом)",
        "• !размут — снять ограничения",
        "• !бан [причина] — заблокировать в группе",
        "• !разбан — снять бан",
        "• !кик — выгнать из группы",
        "• !варн [причина] — предупреждение (3 варна = мут на 24ч)",
        "• !анварн — снять предупреждения",
        "• !дел — удалить сообщение",
        "*(Работает ответом на сообщение нарушителя; время: 10м, 2ч, 1д)*",
    ]
    if role == "creator":
        lines += [
            "",
            "👑 *Только для создателя:*",
            "/tester @user или ID — выдать тестер",
            "/untester @user или ID — забрать тестер",
            "/vip @user или ID — выдать VIP",
            "/unvip @user или ID — забрать VIP",
            "/ban @user или ID — глобальный бан в боте",
            "/unban @user или ID — снять бан в боте",
            "/banlist — список забаненных",
            "/players — список пользователей",
            "Перешли сообщение человека — бот покажет его ID",
        ]
    return "\n".join(lines)


# --------------------------- Таблица лидеров ---------------------------
def firestore_value(value):
    if not value:
        return None
    for key in ("integerValue", "stringValue", "doubleValue", "booleanValue"):
        if key in value:
            return value[key]
    return None


def load_hidden_ids():
    """ID игроков, которые скрылись из списка."""
    if db is None:
        return set()
    try:
        return {document.id for document in db.collection("users").where("hidden", "==", True).stream()}
    except Exception as error:
        print("Ошибка чтения скрытых:", error)
        return set()


def load_banned_ids():
    """ID забаненных игроков."""
    if db is None:
        return set()
    try:
        return {document.id for document in db.collection("users").where("banned", "==", True).stream()}
    except Exception as error:
        print("Ошибка чтения банов:", error)
        return set()


def load_users():
    """Все пользователи для списка/поиска."""
    users = []
    if db is None:
        return users
    try:
        for document in db.collection("users").stream():
            data = document.to_dict() or {}
            users.append({
                "id": document.id,
                "role": data.get("role", "player"),
                "nick": data.get("nick", ""),
                "username": data.get("username"),
                "hidden": bool(data.get("hidden")),
                "banned": bool(data.get("banned")),
            })
    except Exception as error:
        print("Ошибка чтения пользователей:", error)
    users.sort(key=lambda u: u["id"])
    return users


def user_line(user):
    """Строка пользователя: id — роль — ник (+метки)."""
    nick = user.get("nick", "")
    username = user.get("username")
    if username and ("@" + username).lower() != (nick or "").lower():
        nick = f"{nick} @{username}" if nick else f"@{username}"
    tags = ""
    if user.get("hidden"):
        tags += " (скрыт)"
    if user.get("banned"):
        tags += " 🚫"
    return f"{user['id']} — {user.get('role', 'player')} — {nick}{tags}"


def render_users(page, mode, query=None):
    """Текст + inline-клавиатура для страницы списка. mode: 'a' (все) или 's' (поиск)."""
    if mode == "s":
        query = (query or "").strip()
        q = query.lower().lstrip("@")
        users = [
            u for u in load_users()
            if not q
            or q in u["id"].lower()
            or q in (u.get("username") or "").lower()
            or q in (u.get("nick") or "").lower()
        ]
        title = f"🔍 Поиск «{query}» — найдено: {len(users)}"
    else:
        users = load_users()
        title = f"👥 Пользователи — всего: {len(users)}"

    total_pages = max(1, (len(users) + PAGE_SIZE - 1) // PAGE_SIZE)
    page = max(0, min(page, total_pages - 1))
    start = page * PAGE_SIZE
    chunk = users[start:start + PAGE_SIZE]

    lines = [title, ""]
    if not chunk:
        lines.append("Ничего не найдено.")
    for user in chunk:
        lines.append(user_line(user))

    prefix = "sp" if mode == "s" else "pl"
    rows = []
    nav = []
    if page > 0:
        nav.append({"text": "◀ Назад", "callback_data": f"{prefix}:{page - 1}"})
    nav.append({"text": f"стр. {page + 1}/{total_pages}", "callback_data": "noop"})
    if page < total_pages - 1:
        nav.append({"text": "Вперёд ▶", "callback_data": f"{prefix}:{page + 1}"})
    rows.append(nav)
    rows.append([{"text": "🔍 Поиск", "callback_data": "sr"}])

    return "\n".join(lines), {"inline_keyboard": rows}


def render_banlist():
    """Текст бан-листа: по ID и по @username."""
    if db is None:
        return "⚠️ Роли недоступны."

    id_bans = []
    try:
        for document in db.collection("users").where("banned", "==", True).stream():
            data = document.to_dict() or {}
            nick = data.get("nick", "")
            uname = data.get("username")
            extra = f" @{uname}" if uname else ""
            id_bans.append(f"{document.id} — {nick}{extra}")
    except Exception as error:
        print("banlist users error:", error)

    name_bans = []
    try:
        for document in db.collection("banned_usernames").stream():
            name_bans.append("@" + document.id)
    except Exception as error:
        print("banlist usernames error:", error)

    lines = ["🚫 Бан-лист", "", "По ID:"]
    lines += [f"• {item}" for item in id_bans] or ["• пусто"]
    lines += ["", "По @username:"]
    lines += [f"• {item}" for item in name_bans] or ["• пусто"]
    return "\n".join(lines)


def load_leaderboard():
    response = requests.get(FIRESTORE_URL, timeout=30)
    response.raise_for_status()
    documents = response.json().get("documents", [])

    records = []
    for document in documents:
        doc_id = document["name"].rsplit("/", 1)[-1]
        fields = document.get("fields", {})
        records.append({
            "id": doc_id,
            "nick": firestore_value(fields.get("nick")) or "Игрок",
            "wave": int(firestore_value(fields.get("wave")) or 0),
            "gold": int(firestore_value(fields.get("gold")) or 0),
        })

    # Скрытых и забаненных игроков не показываем.
    excluded = load_hidden_ids() | load_banned_ids()
    records = [record for record in records if record["id"] not in excluded]

    records.sort(key=lambda r: (r["wave"], r["gold"]), reverse=True)
    return records


def format_top(records):
    if not records:
        return "📭 Пока нет рекордов. Сыграй в игру и проиграй — рекорд сохранится!"

    lines = ["🏆 *Топ игроков*", ""]
    medals = ["🥇", "🥈", "🥉"]
    for index, record in enumerate(records[:TOP_LIMIT]):
        place = medals[index] if index < len(medals) else f"{index + 1}."
        lines.append(f"{place} {record['nick']} — Волна {record['wave']}, {record['gold']} золота")
    return "\n".join(lines)


def format_player(player_id, records):
    for index, record in enumerate(records):
        if record["id"] == player_id:
            return (
                "📊 *Твой рекорд*\n\n"
                f"Волна: *{record['wave']}*\n"
                f"Золото: *{record['gold']}*\n"
                f"Место в топе: *{index + 1}* из {len(records)}"
            )
    return "🤷 Ты ещё не играл. Пройди игру до Game Over — рекорд сохранится автоматически."


# --------------------------- Модерация и Капча ---------------------------
MODERATION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "moderation_data.json")

MOD_MAP = {
    "мут": "mute", "!мут": "mute", "/mute": "mute", "/мут": "mute",
    "размут": "unmute", "!размут": "unmute", "/unmute": "unmute", "/размут": "unmute",
    "бан": "ban", "!бан": "ban", "/ban": "ban", "/бан": "ban",
    "разбан": "unban", "!разбан": "unban", "/unban": "unban", "/разбан": "unban",
    "кик": "kick", "!кик": "kick", "/kick": "kick", "/кик": "kick",
    "варн": "warn", "!варн": "warn", "/warn": "warn", "/варн": "warn",
    "анварн": "unwarn", "!анварн": "unwarn", "/unwarn": "unwarn", "!снятьварны": "unwarn",
    "дел": "del", "!дел": "del", "/del": "del", "!del": "del",
}


_MOD_DATA_CACHE = None
_MOD_DATA_CACHE_TIME = 0
MOD_CACHE_TTL = 30  # кэш в памяти на 30 сек для защиты от лишних сетевых вызовов

def load_mod_data():
    """Загружает данные модерации (варны, капчи, топики) из кэша памяти, локального файла или Firestore."""
    global _MOD_DATA_CACHE, _MOD_DATA_CACHE_TIME
    now = time.time()
    if _MOD_DATA_CACHE is not None and (now - _MOD_DATA_CACHE_TIME) < MOD_CACHE_TTL:
        return _MOD_DATA_CACHE

    data = None
    if os.path.exists(MODERATION_FILE):
        try:
            with open(MODERATION_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as error:
            print("[ERROR] load_mod_data file error:", error)

    if data is None and db is not None:
        try:
            doc = db.collection("settings").document("moderation").get(timeout=5)
            if doc.exists:
                data = doc.to_dict() or {}
        except Exception as e:
            print("[WARN] Firestore load_mod_data error:", e)

    if not isinstance(data, dict):
        data = {}
    if "warns" not in data:
        data["warns"] = {}
    if "pending_captcha" not in data:
        data["pending_captcha"] = {}
    if "chat_topics" not in data:
        data["chat_topics"] = {}

    _MOD_DATA_CACHE = data
    _MOD_DATA_CACHE_TIME = now
    return _MOD_DATA_CACHE


def save_mod_data(data):
    """Сохраняет данные модерации в память, локальный файл и синхронизирует с Firestore."""
    global _MOD_DATA_CACHE, _MOD_DATA_CACHE_TIME
    _MOD_DATA_CACHE = data
    _MOD_DATA_CACHE_TIME = time.time()

    try:
        with open(MODERATION_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as error:
        print("[ERROR] save_mod_data local:", error)

    if db is not None:
        try:
            db.collection("settings").document("moderation").set(data, merge=True)
        except Exception as e:
            print("[WARN] Firestore save_mod_data error:", e)


CAPTCHA_CATEGORIES = [
    # Геометрия
    ["●", "■", "◆", "▲", "★", "⬟", "✦", "✖", "◈", "▼", "◀", "▶", "⬢", "⬡", "◉", "◎"],
    # Эмодзи еда и фрукты
    ["🍎", "🍌", "🍇", "🍉", "🍓", "🍒", "🍕", "🍔", "🍦", "🍩", "🍪", "🥑", "🥕", "🌽"],
    # Эмодзи космос и техника
    ["🚀", "🛸", "🎮", "👾", "⚡", "🔥", "💎", "⭐", "🔔", "🔑", "🛡", "👑", "🎯", "🎲"],
    # Эмодзи животные
    ["🐱", "🐶", "🦊", "🐼", "🦁", "🐯", "🐸", "🐵", "🦄", "🐧", "🦉", "🐙", "🐬", "🦋"],
    # Масти и символы
    ["♠", "♣", "♥", "♦", "♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"],
    # Цифры и буквы
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "X", "Y", "Z"],
]


def generate_symbol_captcha(chat_id, user_id):
    """Генерирует разнообразную капчу со случайной категорией и 4 кнопками в ряд."""
    category = random.choice(CAPTCHA_CATEGORIES)
    chosen = random.sample(category, 4)
    target = random.choice(chosen)
    buttons = []
    for sym in chosen:
        is_correct = (sym == target)
        cb = f"c_ok:{chat_id}:{user_id}:{sym}" if is_correct else f"c_no:{chat_id}:{user_id}:{sym}"
        buttons.append({"text": sym, "callback_data": cb})
    keyboard = {"inline_keyboard": [buttons]}
    text = (
        "✅ *Быстрая проверка*\n\n"
        f"Чтобы войти в группу, нажмите кнопку с символом: *{target}*\n\n"
        "✅ *Quick check*\n"
        f"To enter the chat, press: *{target}*"
    )
    return text, keyboard, target


def parse_time_str(s):
    """Парсит строку вида '10м', '2ч', '1д' в количество секунд."""
    if not s:
        return None
    s = s.strip().lower()
    if s in ("навсегда", "forever", "0"):
        return 0
    m = re.match(r"^(\d+)\s*([смчдsmhd]|сек|мин|час|дн|день|дня|дней)?$", s)
    if not m:
        return None
    val = int(m.group(1))
    unit = (m.group(2) or "м").lower()
    if unit in ("с", "s", "сек"):
        return max(30, val)
    if unit in ("м", "m", "мин"):
        return val * 60
    if unit in ("ч", "h", "час"):
        return val * 3600
    if unit in ("д", "d", "дн", "день", "дня", "дней"):
        return val * 86400
    return val * 60


def format_duration(seconds):
    """Форматирует секунды в человеческий вид."""
    if not seconds or seconds <= 0:
        return "навсегда"
    if seconds >= 86400:
        return f"{seconds // 86400} дн."
    if seconds >= 3600:
        return f"{seconds // 3600} ч."
    return f"{max(1, seconds // 60)} мин."


_ADMIN_CACHE = {}

def is_chat_admin(chat_id, user_id):
    """Проверяет, является ли пользователь администратором группы (с локальным кэшем на 60 сек)."""
    if str(user_id) == str(CREATOR_ID):
        return True
    key = f"{chat_id}_{user_id}"
    now = time.time()
    if key in _ADMIN_CACHE:
        val, ts = _ADMIN_CACHE[key]
        if now - ts < 60:
            return val
    try:
        res = api("getChatMember", chat_id=chat_id, user_id=user_id)
        if res.get("ok"):
            status = res["result"].get("status")
            is_adm = status in ("creator", "administrator")
            _ADMIN_CACHE[key] = (is_adm, now)
            return is_adm
    except Exception as e:
        print(f"[WARN] is_chat_admin error: {e}")
    return False


def handle_new_chat_members(chat_id, new_members, message_id=None, message_thread_id=None):
    """Ограничивает нового участника и отправляет сообщение-помощник с кнопкой проверки."""
    mod_data = load_mod_data()

    # Топик берём из сохранённых настроек группы или переданного message_thread_id
    target_thread = mod_data.get("chat_topics", {}).get(str(chat_id)) or message_thread_id

    for member in new_members:
        if member.get("is_bot"):
            continue
        uid = member["id"]
        first_name = member.get("first_name") or "Новичок"

        # Создателя и администраторов группы никогда не ограничиваем и не вызываем для них капчу
        if str(uid) == str(CREATOR_ID) or is_chat_admin(chat_id, uid):
            print(f"[CAPTCHA] Skipping admin/creator {uid} ({first_name}) in chat {chat_id}")
            continue

        print(f"[CAPTCHA] Restricting new member {uid} ({first_name}) in chat {chat_id}, thread: {target_thread}")
        api(
            "restrictChatMember",
            chat_id=chat_id,
            user_id=uid,
            permissions={
                "can_send_messages": False,
                "can_send_audios": False,
                "can_send_documents": False,
                "can_send_photos": False,
                "can_send_videos": False,
                "can_send_video_notes": False,
                "can_send_voice_notes": False,
                "can_send_polls": False,
                "can_send_other_messages": False,
                "can_add_web_page_previews": False,
            },
        )

        verify_url = f"https://t.me/{BOT_USERNAME}?start=verify_{chat_id}"
        keyboard = {
            "inline_keyboard": [
                [{"text": "🚪 Пройти капчу", "url": verify_url}]
            ]
        }
        text = (
            f"👋 *Добро пожаловать, {first_name}!*"
            "\n\n"
            "Открой помощника: он может решить частую проблему или сразу провести входную проверку."
            "\n\n"
            "⏳ *На вход и проверку даётся 30 минут.*"
        )

        res = send_group_msg(chat_id, text, thread_id=target_thread, reply_markup=keyboard)
        greet_msg_id = res.get("result", {}).get("message_id") if res.get("ok") else None

        key = f"{chat_id}_{uid}"
        if "pending_captcha" not in mod_data:
            mod_data["pending_captcha"] = {}
        mod_data["pending_captcha"][key] = {
            "chat_id": chat_id,
            "user_id": uid,
            "first_name": first_name,
            "greet_msg_id": greet_msg_id,
            "time": time.time(),
        }
    save_mod_data(mod_data)


def handle_chat_member_update(cm):
    """Событие изменения участника (вход через канал, инвайт, сообщество)."""
    chat = cm.get("chat", {})
    chat_id = chat.get("id")
    chat_type = chat.get("type", "")
    if chat_type not in ("group", "supergroup"):
        return

    old_status = cm.get("old_chat_member", {}).get("status")
    new_cm = cm.get("new_chat_member", {})
    new_status = new_cm.get("status")
    new_user = new_cm.get("user", {})

    if not new_user or new_user.get("is_bot"):
        return

    uid = new_user.get("id")
    if str(uid) == str(CREATOR_ID) or is_chat_admin(chat_id, uid):
        return

    print(f"[CHAT_MEMBER] Chat {chat_id}: user {new_user.get('id')} ({new_user.get('first_name')}) status {old_status} -> {new_status}")
    if old_status in ("left", "kicked", None) and new_status in ("member", "restricted"):
        handle_new_chat_members(chat_id, [new_user], message_id=None, message_thread_id=None)


def handle_captcha_callback(callback):
    """Снимает ограничения после нажатия старой кнопки капчи (обратная совместимость)."""
    callback_id = callback.get("id")
    user_id = callback.get("from", {}).get("id")
    chat_id = callback.get("message", {}).get("chat", {}).get("id")
    message_id = callback.get("message", {}).get("message_id")
    data = callback.get("data", "")

    target_chat = data.replace("verify_pass_", "").strip()
    try:
        target_chat_id = int(target_chat)
    except ValueError:
        target_chat_id = target_chat

    api(
        "restrictChatMember",
        chat_id=target_chat_id,
        user_id=user_id,
        permissions={
            "can_send_messages": True,
            "can_send_audios": True,
            "can_send_documents": True,
            "can_send_photos": True,
            "can_send_videos": True,
            "can_send_video_notes": True,
            "can_send_voice_notes": True,
            "can_send_polls": True,
            "can_send_other_messages": True,
            "can_add_web_page_previews": True,
        },
    )

    mod_data = load_mod_data()
    key = f"{target_chat_id}_{user_id}"
    pending = mod_data.get("pending_captcha", {}).pop(key, None)
    save_mod_data(mod_data)

    if pending and pending.get("greet_msg_id"):
        try:
            api("deleteMessage", chat_id=target_chat_id, message_id=pending["greet_msg_id"])
        except Exception:
            pass

    api("answerCallbackQuery", callback_query_id=callback_id, text="Проверка пройдена! Чат разблокирован.")
    api(
        "editMessageText",
        chat_id=chat_id,
        message_id=message_id,
        text=(
            "✅ *Проверка успешно пройдена!*\n\n"
            "Ограничения в чате сняты — можешь свободно писать.\n\n"
            "🎮 А пока общаешься, сыграй в *Spore Tower Defense*!\n"
            "Кнопка запуска находится в меню слева."
        ),
        parse_mode="Markdown",
    )


def send_group_msg(chat_id, text, thread_id=None, reply_to=None, **kwargs):
    """Отправляет сообщение в группу с поддержкой топиков (тем) и фоллбэком."""
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    }
    if reply_to:
        payload["reply_to_message_id"] = reply_to
    if thread_id:
        payload["message_thread_id"] = thread_id
    if "keyboard" in kwargs:
        payload["reply_markup"] = kwargs.pop("keyboard")
    payload.update(kwargs)
    res = api("sendMessage", **payload)
    if not res.get("ok"):
        desc = res.get("description", "").lower()
        print(f"[GROUP_MSG] Error sending with thread_id={thread_id}: {res}")
        if "can't parse entities" in desc:
            payload.pop("parse_mode", None)
            res = api("sendMessage", **payload)
            print(f"[GROUP_MSG] Fallback without Markdown: {res.get('ok')}")
        elif thread_id and any(k in desc for k in ("thread not found", "message thread not found", "top_message")):
            payload.pop("message_thread_id", None)
            res = api("sendMessage", **payload)
            if not res.get("ok") and "can't parse entities" in res.get("description", "").lower():
                payload.pop("parse_mode", None)
                res = api("sendMessage", **payload)
            print(f"[GROUP_MSG] Fallback to chat root: {res.get('ok')}")
    return res


def handle_moderation_command(message, cmd, args):
    """Обрабатывает команды модератора: мут, бан, кик, варн, дел и т.д."""
    chat_id = message["chat"]["id"]
    thread_id = message.get("message_thread_id")
    sender = message.get("from", {})
    sender_id = sender.get("id")
    message_id = message.get("message_id")
    reply_to = message.get("reply_to_message")

    def msg_reply(text):
        return send_group_msg(chat_id, text, thread_id=thread_id, reply_to=message_id)

    # Команды модерации бота временно разрешены только создателю
    if str(sender_id) != str(CREATOR_ID):
        msg_reply("⛔ Команды бота временно доступны только создателю.")
        return

    if cmd == "del":
        if reply_to:
            api("deleteMessage", chat_id=chat_id, message_id=reply_to.get("message_id"))
            api("deleteMessage", chat_id=chat_id, message_id=message_id)
        else:
            msg_reply("ℹ️ Ответьте на сообщение нарушителя командой `!дел`")
        return

    target_id = None
    target_name = None

    if reply_to:
        reply_user = reply_to.get("from", {})
        target_id = reply_user.get("id")
        target_name = reply_user.get("first_name") or "Пользователь"
        if reply_user.get("username"):
            target_name = f"@{reply_user['username']}"
    else:
        if args and (args[0].startswith("@") or args[0].isdigit()):
            raw_target = args[0]
            args = args[1:]
            if raw_target.isdigit():
                target_id = int(raw_target)
                target_name = f"ID:{target_id}"
            else:
                uname = raw_target.lstrip("@")
                doc_id, _ = resolve_target(f"@{uname}")
                if doc_id and doc_id.isdigit():
                    target_id = int(doc_id)
                target_name = f"@{uname}"

    if not target_id:
        msg_reply("ℹ️ Ответьте на сообщение пользователя или укажите: `!команда @username`")
        return

    me = api("getMe")
    if me.get("ok") and target_id == me["result"]["id"]:
        msg_reply("🤖 Нельзя применить команду к боту.")
        return

    if is_chat_admin(chat_id, target_id):
        msg_reply("⚠️ Нельзя применить действие к администратору группы.")
        return

    duration = None
    reason_parts = []
    for a in args:
        sec = parse_time_str(a)
        if sec is not None and duration is None:
            duration = sec
        else:
            reason_parts.append(a)
    reason = " ".join(reason_parts).strip() or "Не указана"

    mod_data = load_mod_data()

    if cmd == "mute":
        if duration is None:
            duration = 3600
        until_date = int(time.time()) + duration if duration > 0 else 0
        res = api(
            "restrictChatMember",
            chat_id=chat_id,
            user_id=target_id,
            until_date=until_date,
            permissions={
                "can_send_messages": False,
                "can_send_audios": False,
                "can_send_documents": False,
                "can_send_photos": False,
                "can_send_videos": False,
                "can_send_video_notes": False,
                "can_send_voice_notes": False,
                "can_send_polls": False,
                "can_send_other_messages": False,
                "can_add_web_page_previews": False,
            },
        )
        if res.get("ok"):
            time_str = format_duration(duration)
            msg_reply(f"🔇 *{target_name}* замучен на *{time_str}*.\n📝 *Причина:* {reason}")
        else:
            msg_reply(f"⚠️ Ошибка мута: {res.get('description', 'Недостаточно прав')}")

    elif cmd == "unmute":
        res = api(
            "restrictChatMember",
            chat_id=chat_id,
            user_id=target_id,
            permissions={
                "can_send_messages": True,
                "can_send_audios": True,
                "can_send_documents": True,
                "can_send_photos": True,
                "can_send_videos": True,
                "can_send_video_notes": True,
                "can_send_voice_notes": True,
                "can_send_polls": True,
                "can_send_other_messages": True,
                "can_add_web_page_previews": True,
            },
        )
        if res.get("ok"):
            msg_reply(f"🔊 С *{target_name}* сняты ограничения (размут).")
        else:
            msg_reply(f"⚠️ Ошибка размута: {res.get('description', 'Недостаточно прав')}")

    elif cmd == "ban":
        res = api("banChatMember", chat_id=chat_id, user_id=target_id)
        if res.get("ok"):
            msg_reply(f"⛔ *{target_name}* заблокирован в группе.\n📝 *Причина:* {reason}")
        else:
            msg_reply(f"⚠️ Ошибка бана: {res.get('description', 'Недостаточно прав')}")

    elif cmd == "unban":
        res = api("unbanChatMember", chat_id=chat_id, user_id=target_id, only_if_banned=True)
        if res.get("ok"):
            msg_reply(f"✅ *{target_name}* разблокирован в группе.")
        else:
            msg_reply(f"⚠️ Ошибка разбана: {res.get('description', 'Не удалось')}")

    elif cmd == "kick":
        res = api("banChatMember", chat_id=chat_id, user_id=target_id)
        if res.get("ok"):
            api("unbanChatMember", chat_id=chat_id, user_id=target_id)
            msg_reply(f"🚪 *{target_name}* исключён из группы.\n📝 *Причина:* {reason}")
        else:
            msg_reply(f"⚠️ Ошибка кика: {res.get('description', 'Недостаточно прав')}")

    elif cmd == "warn":
        warn_key = f"{chat_id}_{target_id}"
        if "warns" not in mod_data:
            mod_data["warns"] = {}
        current_warns = mod_data["warns"].get(warn_key, 0) + 1
        if current_warns >= 3:
            mod_data["warns"][warn_key] = 0
            save_mod_data(mod_data)
            until_date = int(time.time()) + 86400
            api(
                "restrictChatMember",
                chat_id=chat_id,
                user_id=target_id,
                until_date=until_date,
                permissions={
                    "can_send_messages": False,
                    "can_send_audios": False,
                    "can_send_documents": False,
                    "can_send_photos": False,
                    "can_send_videos": False,
                    "can_send_video_notes": False,
                    "can_send_voice_notes": False,
                    "can_send_polls": False,
                    "can_send_other_messages": False,
                    "can_add_web_page_previews": False,
                },
            )
            msg_reply(f"🚫 *{target_name}* получил предупреждение (*3/3*).\n\nЛимит исчерпан — выдан мут на *24 часа*!\n📝 *Причина:* {reason}")
        else:
            mod_data["warns"][warn_key] = current_warns
            save_mod_data(mod_data)
            msg_reply(f"⚠️ *{target_name}* получил предупреждение (*{current_warns}/3*).\n📝 *Причина:* {reason}")

    elif cmd == "unwarn":
        warn_key = f"{chat_id}_{target_id}"
        if "warns" in mod_data and warn_key in mod_data["warns"]:
            del mod_data["warns"][warn_key]
            save_mod_data(mod_data)
        msg_reply(f"✅ С *{target_name}* сняты все предупреждения.")


# ------------------------------ Обработка ------------------------------
def handle_callback(callback):
    """Нажатия на inline-кнопки."""
    data = callback.get("data", "")
    message = callback.get("message", {})
    chat_id = message.get("chat", {}).get("id")
    message_id = message.get("message_id")
    user_id = str(callback.get("from", {}).get("id", ""))
    is_creator = str(user_id) == str(CREATOR_ID)

    if data.startswith("c_ok:") or data.startswith("c_no:"):
        is_ok = data.startswith("c_ok:")
        parts = data.split(":")
        target_chat = parts[1]
        target_user_id = parts[2]

        if str(user_id) != str(target_user_id) and str(user_id) != str(CREATOR_ID):
            api("answerCallbackQuery", callback_query_id=callback.get("id"), text="⚠️ Эта проверка для другого пользователя!", show_alert=True)
            return

        if not is_ok:
            api("answerCallbackQuery", callback_query_id=callback.get("id"), text="❌ Неверный символ! Попробуйте ещё раз.", show_alert=True)
            new_text, new_kb, _ = generate_symbol_captcha(target_chat, target_user_id)
            api("editMessageText", chat_id=chat_id, message_id=message_id, text=new_text, reply_markup=new_kb, parse_mode="Markdown")
            return

        api("answerCallbackQuery", callback_query_id=callback.get("id"), text="✅ Проверка пройдена!")

        if target_chat != "test":
            try:
                target_chat_id = int(target_chat)
            except ValueError:
                target_chat_id = target_chat

            api(
                "restrictChatMember",
                chat_id=target_chat_id,
                user_id=int(target_user_id),
                permissions={
                    "can_send_messages": True,
                    "can_send_audios": True,
                    "can_send_documents": True,
                    "can_send_photos": True,
                    "can_send_videos": True,
                    "can_send_video_notes": True,
                    "can_send_voice_notes": True,
                    "can_send_polls": True,
                    "can_send_other_messages": True,
                    "can_add_web_page_previews": True,
                },
            )

            mod_data = load_mod_data()
            key = f"{target_chat_id}_{target_user_id}"
            pending = mod_data.get("pending_captcha", {}).pop(key, None)
            save_mod_data(mod_data)

            if pending and pending.get("greet_msg_id"):
                try:
                    api("deleteMessage", chat_id=target_chat_id, message_id=pending["greet_msg_id"])
                except Exception:
                    pass

        success_keyboard = {
            "inline_keyboard": [
                [{"text": "🎮 Играть в Spore TD", "web_app": {"url": GAME_URL}}]
            ]
        }
        api(
            "editMessageText",
            chat_id=chat_id,
            message_id=message_id,
            text=(
                "✅ *Проверка успешно пройдена!*\n\n"
                "Ограничения в группе сняты — добро пожаловать в чат!\n\n"
                "🎮 А пока общаешься, сыграй в нашу игру *Spore Tower Defense*!"
            ),
            reply_markup=success_keyboard,
            parse_mode="Markdown",
        )
        return

    if data.startswith("verify_pass_"):
        handle_captcha_callback(callback)
        return

    # Все остальные inline-действия (настройки, список, поиск, баны) — строго только для создателя
    if not is_creator:
        api("answerCallbackQuery", callback_query_id=callback.get("id"), text="⛔ Доступно только создателю.", show_alert=True)
        return

    if data == "toggle_hidden":
        new_value = toggle_hidden(user_id)
        api("answerCallbackQuery", callback_query_id=callback.get("id"))
        if new_value is None:
            return
        api(
            "editMessageText",
            chat_id=chat_id,
            message_id=message_id,
            text=settings_text(user_id),
            reply_markup=settings_keyboard(user_id),
        )
        return

    def edit(text, keyboard):
        api(
            "editMessageText",
            chat_id=chat_id,
            message_id=message_id,
            text=text,
            reply_markup=keyboard,
        )

    if data == "noop":
        api("answerCallbackQuery", callback_query_id=callback.get("id"))
        return

    if data == "sr":
        search_pending[chat_id] = True
        api("answerCallbackQuery", callback_query_id=callback.get("id"))
        edit("🔍 Отправь @username, ник или ID для поиска.", {"inline_keyboard": []})
        return

    if data.startswith("bt:"):
        _, mode, page, uid = data.split(":", 3)
        toggle_ban(uid)
        query = search_query.get(chat_id) if mode == "s" else None
        text, keyboard = render_users(int(page), mode, query)
        api("answerCallbackQuery", callback_query_id=callback.get("id"))
        edit(text, keyboard)
        return

    if data.startswith("pl:") or data.startswith("sp:"):
        mode = "a" if data.startswith("pl:") else "s"
        page = int(data.split(":", 1)[1])
        query = search_query.get(chat_id) if mode == "s" else None
        text, keyboard = render_users(page, mode, query)
        api("answerCallbackQuery", callback_query_id=callback.get("id"))
        edit(text, keyboard)
        return


def handle_update(update):
    global CURRENT_KEYBOARD

    chat_member = update.get("chat_member")
    if chat_member:
        handle_chat_member_update(chat_member)
        return

    callback = update.get("callback_query")
    if callback:
        handle_callback(callback)
        return

    message = update.get("message")
    if not message:
        return

    chat = message.get("chat", {})
    chat_id = chat.get("id")
    chat_type = chat.get("type", "private")
    thread_id = message.get("message_thread_id")
    sender = message.get("from", {})
    user_id = str(sender.get("id", ""))
    username = sender.get("username")
    text = (message.get("text") or "").strip()
    if text:
        print(f"[MSG] chat={chat_id} ({chat_type}) from={user_id}: {text}")

    # ---------------- Групповые сообщения (Капча и Модерация) ----------------
    if chat_type in ("group", "supergroup"):
        reply_to = message.get("reply_to_message")

        # Удаление сервисного сообщения Telegram "Пользователь вошёл в группу" + вызов капчи
        new_members = message.get("new_chat_members") or ([message["new_chat_participant"]] if message.get("new_chat_participant") else None)
        if new_members:
            mid = message.get("message_id")
            del_res = api("deleteMessage", chat_id=chat_id, message_id=mid)
            if not del_res.get("ok"):
                print(f"[WARN] deleteMessage failed for new_chat_members: {del_res}")
            handle_new_chat_members(chat_id, new_members, mid, thread_id)
            return

        # Удаление сервисного сообщения Telegram "Пользователь покинул группу"
        if message.get("left_chat_member"):
            mid = message.get("message_id")
            del_res = api("deleteMessage", chat_id=chat_id, message_id=mid)
            if not del_res.get("ok"):
                print(f"[WARN] deleteMessage failed for left_chat_member: {del_res}")
            return

        # Если участник ещё не прошёл капчу, удаляем его сообщения из группы
        pending_key = f"{chat_id}_{user_id}"
        mod_data = load_mod_data()
        if pending_key in mod_data.get("pending_captcha", {}):
            if str(user_id) == str(CREATOR_ID) or is_chat_admin(chat_id, user_id):
                mod_data["pending_captcha"].pop(pending_key, None)
                save_mod_data(mod_data)
            else:
                try:
                    api("deleteMessage", chat_id=chat_id, message_id=message.get("message_id"))
                except Exception:
                    pass
                return

        if text:
            parts = text.split()
            first_token = parts[0].lower().split("@")[0]
            is_creator = str(user_id) == str(CREATOR_ID)

            is_mod_cmd = (first_token in MOD_MAP) or (first_token.lstrip("!/") in MOD_MAP)
            is_bot_cmd = (
                first_token.startswith(("/", "!"))
                or is_mod_cmd
                or first_token in ("капча", "проверка", "тест", "чек", "топик", "хелп", "помощь")
            )

            if is_bot_cmd:
                if not is_creator:
                    send_group_msg(
                        chat_id,
                        "⛔ Команды бота временно доступны только создателю.",
                        thread_id=thread_id,
                        reply_to=message.get("message_id"),
                    )
                    return

                # Команда назначения текущего топика для приветствий и проверок (только создатель)
                if first_token in ("!топик", "!сеттопик", "/settopic"):
                    mod_data = load_mod_data()
                    if "chat_topics" not in mod_data:
                        mod_data["chat_topics"] = {}
                    mod_data["chat_topics"][str(chat_id)] = thread_id
                    save_mod_data(mod_data)
                    send_group_msg(
                        chat_id,
                        f"✅ Топик сохранён для приветствий и капчи!\n🧵 *ID топика:* `{thread_id or 'General'}`",
                        thread_id=thread_id,
                        reply_to=message.get("message_id"),
                    )
                    return

                # Команда проверки статуса бота в этом топике (только создатель)
                if first_token in ("!тест", "!чек", "/test", "/check"):
                    bot_me = api("getMe").get("result", {})
                    bot_perms = api("getChatMember", chat_id=chat_id, user_id=bot_me.get("id")).get("result", {})
                    can_del = bot_perms.get("can_delete_messages", False)
                    can_restr = bot_perms.get("can_restrict_members", False)
                    can_top = bot_perms.get("can_manage_topics", False)
                    status = bot_perms.get("status", "unknown")
                    mod_data = load_mod_data()
                    saved_top = mod_data.get("chat_topics", {}).get(str(chat_id))
                    send_group_msg(
                        chat_id,
                        f"🤖 *SporeTD Bot активен в этой ветке!*\n\n"
                        f"📍 *ID чата:* `{chat_id}`\n"
                        f"🧵 *Топик:* `{thread_id or 'General'}` (настроенный для капчи: `{saved_top or 'не задан'}`)\n"
                        f"👑 *Статус:* `{status}`\n"
                        f"🗑 Удаление сообщений: *{'✅' if can_del else '❌'}*\n"
                        f"🔇 Ограничение/мут: *{'✅' if can_restr else '❌'}*\n"
                        f"📂 Управление темами: *{'✅' if can_top else '❌'}*",
                        thread_id=thread_id,
                        reply_to=message.get("message_id"),
                    )
                    return

                # Команда ручного вызова капчи или теста капчи (только создатель)
                if first_token in ("!капча", "!проверка", "/captcha", "/testcaptcha", "!тесткапча"):
                    if reply_to:
                        target_u = reply_to.get("from", {})
                        t_uid = target_u.get("id")
                        if str(t_uid) == str(CREATOR_ID):
                            send_group_msg(chat_id, "⚠️ Нельзя вызвать проверку для создателя.", thread_id=thread_id, reply_to=message.get("message_id"))
                            return
                        handle_new_chat_members(chat_id, [target_u], reply_to.get("message_id"), thread_id)
                    else:
                        captcha_text, captcha_kb, _ = generate_symbol_captcha(str(chat_id), user_id)
                        send_group_msg(chat_id, f"🧪 *Тестовая проверка:*\n\n{captcha_text}", thread_id=thread_id, reply_to=message.get("message_id"), keyboard=captcha_kb)
                    return

                cmd = MOD_MAP.get(first_token) or MOD_MAP.get(first_token.lstrip("!/"))
                if cmd:
                    handle_moderation_command(message, cmd, parts[1:])
                    return

                if first_token in ("/help", "!help", "!хелп", "!помощь"):
                    help_text = (
                        "🛡 *Команды (доступны только создателю):*\n\n"
                        "• `!мут [время] [причина]` — замутить нарушителя\n"
                        "• `!размут` — снять мут\n"
                        "• `!бан [причина]` — заблокировать в группе\n"
                        "• `!разбан [@user / ID]` — разблокировать\n"
                        "• `!кик` — исключить из группы\n"
                        "• `!варн [причина]` — предупреждение (3 варна = мут на 24ч)\n"
                        "• `!анварн` — снять все предупреждения\n"
                        "• `!дел` — удалить сообщение\n"
                        "• `!капча` — принудительно выдать проверку участнику (ответом) или протестировать капчу\n"
                        "• `!топик` — назначить текущую тему для приветствий\n"
                        "• `!тест` — проверить статус бота и права в топике\n\n"
                        "⏱ *Время:* `10м`, `2ч`, `1д` (если не указано — 1 час)."
                    )
                    send_group_msg(chat_id, help_text, thread_id=thread_id, reply_to=message.get("message_id"))
                    return

                send_group_msg(chat_id, "ℹ️ В группе поддерживаются команды модерации и капчи. Список: `!help`", thread_id=thread_id, reply_to=message.get("message_id"))
                return

        return

    # ---------------- Личные сообщения ----------------
    is_creator = str(user_id) == str(CREATOR_ID)

    if text.startswith("/start verify_"):
        target_chat = text.replace("/start verify_", "").strip()
        captcha_text, captcha_kb, _ = generate_symbol_captcha(target_chat, user_id)
        send_message(
            chat_id,
            captcha_text,
            keyboard=captcha_kb,
        )
        return

    if not is_creator:
        send_message(
            chat_id,
            "⛔ Команды бота временно доступны только создателю.",
            markdown=False,
            keyboard={"remove_keyboard": True},
        )
        return

    if text in ("/testcaptcha", "/captcha", "!капча", "!тесткапча"):
        captcha_text, captcha_kb, _ = generate_symbol_captcha("test", user_id)
        send_message(
            chat_id,
            captcha_text,
            keyboard=captcha_kb,
        )
        return

    ensure_user(user_id, user_nick(message), username)
    is_creator = str(user_id) == str(CREATOR_ID)

    role = "player"
    if db is not None:
        snapshot = db.collection("users").document(user_id).get()
        if snapshot.exists:
            role = snapshot.to_dict().get("role", "player")
    if is_creator:
        role = "creator"

    # Клавиатура внизу (тестерам/создателю — с кнопкой тестовой версии).
    CURRENT_KEYBOARD = menu_keyboard(role)

    # Забаненным (кроме создателя) доступ к боту закрыт.
    # Бан по ID или по @username (второй работает даже до первого входа).
    if not is_creator:
        banned = bool(get_user_data(user_id).get("banned")) or is_username_banned(username)
        if banned:
            if username:
                set_ban(user_id, True)
            send_message(chat_id, "🚫 Доступ к боту закрыт.", markdown=False)
            return

    # Создатель переслал сообщение — достаём ID автора (даже если он боту не писал).
    if is_creator:
        origin = message.get("forward_origin") or {}
        forwarded = (
            origin.get("sender_user")
            if origin.get("type") == "user"
            else message.get("forward_from")
        )
        if forwarded and forwarded.get("id"):
            fwd_id = forwarded["id"]
            fwd_username = forwarded.get("username")
            fwd_name = " ".join(
                filter(None, [forwarded.get("first_name"), forwarded.get("last_name")])
            ) or "без имени"
            uname_line = f"\n@{fwd_username}" if fwd_username else ""
            send_message(
                chat_id,
                f"🆔 ID: {fwd_id}{uname_line}\n{fwd_name}\n\n"
                f"Забанить: /ban {fwd_id}\nРазбанить: /unban {fwd_id}",
                markdown=False,
            )
            return
        if origin.get("type") == "hidden_user" or message.get("forward_sender_name"):
            send_message(chat_id, "Автор пересланного сообщения скрыл аккаунт — ID недоступен.", markdown=False)
            return

    # Создатель запросил поиск — следующее его сообщение это запрос.
    if is_creator and search_pending.get(chat_id) and text:
        search_pending[chat_id] = False
        search_query[chat_id] = text
        result_text, keyboard = render_users(0, "s", text)
        send_message(chat_id, result_text, markdown=False, keyboard=keyboard)
        return

    if text in ("/start", "/menu"):
        send_message(
            chat_id,
            "🏰 *Spore Tower Defense (Alpha)*\n"
            "\n"
            "Строй башни и не пусти врагов до конца дороги.\n"
            "\n"
            "Личный рекорд и место в топе автоматически сохраняются.\n"
            "\n"
            "🎮 Нажми «Играть» слева, чтобы начать.",
        )
    elif text in ("/help", "/commands", HELP_BUTTON):
        send_message(chat_id, commands_text(role))
    elif text in ("/settings", SETTINGS_BUTTON):
        send_message(
            chat_id,
            settings_text(user_id),
            markdown=False,
            keyboard=settings_keyboard(user_id),
        )
    elif text == TOP_BUTTON:
        try:
            send_message(chat_id, format_top(load_leaderboard()), markdown=False)
        except Exception as error:
            print("Ошибка чтения Firebase:", error)
            send_message(chat_id, "⚠️ Не удалось загрузить рекорды. Попробуй позже.")
    elif text in ("/me", "/stats", ME_BUTTON):
        try:
            if user_id in load_hidden_ids():
                send_message(
                    chat_id,
                    "🙈 Ты скрыт из списка. Вернуть можно кнопкой ⚙ Настройки.",
                    markdown=False,
                )
            else:
                send_message(chat_id, format_player(user_id, load_leaderboard()))
        except Exception as error:
            print("Ошибка чтения Firebase:", error)
            send_message(chat_id, "⚠️ Не удалось загрузить рекорд. Попробуй позже.")
    elif text in ("/unity", "/unitytest"):
        if role not in ("creator", "tester"):
            send_message(chat_id, "⛔ Версия Unity сейчас доступна только создателю и тестерам.")
            return
        send_message(
            chat_id,
            "🎮 *Spore TD (Unity WebGL)*\n\nНажми кнопку ниже для запуска тестовой Unity-версии:",
            keyboard={
                "inline_keyboard": [
                    [{"text": "🚀 Запустить Unity WebGL", "web_app": {"url": UNITY_URL}}]
                ]
            },
        )
    elif text == "/whoami":
        send_message(chat_id, f"Твой ID: `{user_id}`\nРоль: *{role}*")
    elif text.startswith("/vip") or text.startswith("/unvip"):
        if not is_creator:
            send_message(chat_id, "⛔ Команда только для создателя.")
            return
        parts = text.split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            send_message(chat_id, "Укажи пользователя: `/vip @username` или `/vip 123456789`")
            return
        target = parts[1].strip()
        new_role = "vip" if text.startswith("/vip") else "player"
        doc_id, error = resolve_target(target)
        if error:
            send_message(chat_id, f"⚠️ {error}")
            return
        if set_role(doc_id, new_role):
            label = ROLE_LABELS.get(new_role) or "player"
            send_message(chat_id, f"✅ `{target}` — роль: *{label}*")
        else:
            send_message(chat_id, "⚠️ Не удалось сохранить роль.")
    elif text.startswith("/tester") or text.startswith("/untester"):
        if not is_creator:
            send_message(chat_id, "⛔ Команда только для создателя.")
            return
        parts = text.split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            send_message(chat_id, "Укажи пользователя: `/tester @username` или `/tester 123456789`")
            return
        target = parts[1].strip()
        new_role = "tester" if text.startswith("/tester") else "player"
        doc_id, error = resolve_target(target)
        if error:
            send_message(chat_id, f"⚠️ {error}")
            return
        if set_role(doc_id, new_role):
            label = ROLE_LABELS.get(new_role) or "player"
            send_message(chat_id, f"✅ `{target}` — роль: *{label}*")
        else:
            send_message(chat_id, "⚠️ Не удалось сохранить роль.")
    elif text == "/players":
        if not is_creator:
            send_message(chat_id, "⛔ Команда только для создателя.")
            return
        if db is None:
            send_message(chat_id, "⚠️ Роли недоступны.")
            return
        result_text, keyboard = render_users(0, "a")
        send_message(chat_id, result_text, markdown=False, keyboard=keyboard)
    elif text == "/banlist":
        if not is_creator:
            send_message(chat_id, "⛔ Команда только для создателя.")
            return
        send_message(chat_id, render_banlist(), markdown=False)
    elif text.startswith("/ban") or text.startswith("/unban"):
        if not is_creator:
            send_message(chat_id, "⛔ Команда только для создателя.")
            return
        parts = text.split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            send_message(chat_id, "Укажи: `/ban @username` или `/ban 123456789`")
            return
        target = parts[1].strip()
        want_ban = text.startswith("/ban")
        verb = "🚫 Забанен" if want_ban else "✅ Разбанен"

        # По числовому ID.
        if target.isdigit():
            if set_ban(target, want_ban):
                send_message(chat_id, f"{verb}: `{target}`")
            else:
                send_message(chat_id, "⚠️ Не удалось сохранить.")
            return

        # По @username — работает и без входа в бота.
        set_username_ban(target, want_ban)
        doc_id, error = resolve_target(target)
        if not error:
            set_ban(doc_id, want_ban)
        send_message(chat_id, f"{verb}: @{target.lstrip('@')} — сработает и до первого входа.")


def main():
    print("Бот запущен. Нажми Ctrl+C, чтобы остановить.")

    init_firebase()

    me = api("getMe")
    if not me.get("ok"):
        print("Ошибка авторизации бота:", me)
        return
    print("Бот:", me["result"]["username"])

    api("deleteWebhook", drop_pending_updates=False)

    try:
        api("setChatMenuButton", menu_button={"type": "web_app", "text": "Играть", "web_app": {"url": GAME_URL}})
    except Exception as e:
        print("Ошибка установки menu_button:", e)

    offset = 0
    while True:
        try:
            res = api(
                "getUpdates",
                offset=offset,
                timeout=15,
                allowed_updates=["message", "edited_message", "callback_query", "chat_member"],
            )
            if not res.get("ok"):
                time.sleep(2)
                continue
            updates = res.get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                handle_update(update)
        except KeyboardInterrupt:
            print("Остановлено.")
            break
        except Exception as error:
            print("Ошибка в основном цикле, повтор через 3 сек:", error)
            time.sleep(3)


if __name__ == "__main__":
    main()
