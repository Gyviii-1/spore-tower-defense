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
CREATOR_ID = os.environ.get("CREATOR_ID") or "1802519292"
CREATOR_USERNAME = os.environ.get("CREATOR_USERNAME") or "gyviii"
PROJECT_ID = "telegram-tower-defense"
API_KEY = "AIzaSyDSIr6tflEu5cYQNXexM0co5hqkDXMVd8Y"
SA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "service-account.json")
SA_B64 = os.environ.get("FIREBASE_SERVICE_ACCOUNT")

# Локальный config.py (не попадает в Git) может переопределить настройки.
try:
    import config

    BOT_TOKEN = BOT_TOKEN or getattr(config, "BOT_TOKEN", None)
    CREATOR_ID = CREATOR_ID or getattr(config, "CREATOR_ID", None)
    CREATOR_USERNAME = getattr(config, "CREATOR_USERNAME", CREATOR_USERNAME)
    PROJECT_ID = getattr(config, "PROJECT_ID", PROJECT_ID)
    API_KEY = getattr(config, "API_KEY", API_KEY)
except ImportError:
    pass

def is_creator_user(user_id, username=None):
    """Проверяет, является ли пользователь создателем по ID или @username."""
    if user_id and str(user_id) == str(CREATOR_ID):
        return True
    if username and str(username).lower().lstrip('@') == str(CREATOR_USERNAME).lower().lstrip('@'):
        return True
    return False

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
GAME_URL = "https://170-168-76-97.sslip.io/unity/"
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
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

def _create_http_session():
    sess = requests.Session()
    retries = Retry(total=2, backoff_factor=0.3, status_forcelist=[500, 502, 503, 504], raise_on_status=False)
    adapter = HTTPAdapter(max_retries=retries, pool_connections=5, pool_maxsize=10)
    sess.mount("https://", adapter)
    sess.mount("http://", adapter)
    return sess

SESSION_UPDATES = _create_http_session()
SESSION_API = _create_http_session()

def api(method, **params):
    """Вызов метода Telegram Bot API с пулом и автоматическим переподключением."""
    global SESSION_UPDATES, SESSION_API
    is_get_updates = (method == "getUpdates")
    timeout = 25 if is_get_updates else 12
    max_attempts = 1 if is_get_updates else 3

    last_error = None
    for attempt in range(max_attempts):
        sess = SESSION_UPDATES if is_get_updates else SESSION_API
        try:
            response = sess.post(f"{API}/{method}", json=params, timeout=timeout)
            return response.json()
        except Exception as e:
            last_error = e
            print(f"[API ERROR] {method} (попытка {attempt+1}/{max_attempts}): {e}")
            try:
                if is_get_updates:
                    SESSION_UPDATES.close()
                    SESSION_UPDATES = _create_http_session()
                else:
                    SESSION_API.close()
                    SESSION_API = _create_http_session()
            except Exception:
                pass
            if attempt < max_attempts - 1:
                time.sleep(0.3)
    return {"ok": False, "description": str(last_error)}


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

    uname_lower = target.lower()
    docs = list(db.collection("users").where("username", "==", uname_lower).limit(1).stream())
    if not docs:
        docs = list(db.collection("users").where("username", "==", target).limit(1).stream())
    if not docs:
        docs = list(db.collection("users").where("username", "==", f"@{uname_lower}").limit(1).stream())
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
    """Список доступных команд с учётом роли (Iris Style)."""
    lines = [
        "📖 *Справочник команд (в стиле Iris CM)*",
        "",
        "💡 _Все команды работают без восклицательного знака (естественный ввод)_",
        "",
        "🎮 *Игра Spore Tower Defense:*",
        "• Играть — кнопка «Играть» слева внизу",
        "• Топ-10 и личный рекорд — кнопки меню внизу",
        "• /whoami (или `ранг`) — мой ID и статус в боте",
        "• /settings — настройки профиля",
        "• помощь / правила / команды — эта справка",
        "",
        "🛡 *Модерация чата (в группах):*",
        "• мут [время] [причина] — ограничить отправку сообщений (ответом или @user)",
        "• размут — снять ограничения",
        "• бан [причина] — заблокировать в группе (Админ+)",
        "• разбан [@user / ID] — снять бан",
        "• кик [причина] — выгнать из группы",
        "• варн [причина] — предупреждение (3 варна = мут на 24ч)",
        "• анварн — снять предупреждения",
        "• дел — удалить сообщение нарушителя (ответом)",
        "• капча — выдать проверку участнику (ответом)",
        "",
        "👑 *Иерархия и управление:*",
        "• состав — список администрации чата",
        "• ранг — мой текущий ранг и права",
        "• админ @user / снять админ @user — управление администраторами (Создатель)",
        "• модер @user / снять модер @user — управление модераторами (Админ+)",
        "• снять @user — разжаловать",
        "",
        "🎯 *Цели и Буст чата:*",
        "• цель — прогресс цели чата",
        "• сетцель [число] [описание] — установить цель чата (Админ+)",
        "• +прогресс [число] — добавить прогресс к цели",
        "• буст — уровень прокачки чата и перки",
        "*(Время наказаний: 10м, 2ч, 1д; по умолчанию 1 час)*",
    ]
    if role == "creator":
        lines += [
            "",
            "👑 *Только для создателя:*",
            "• вайтлист — белый список разрешённых чатов бота",
            "• +чат [ID] [название] — добавить чат в белый список (в ЛС бота)",
            "• -чат [ID] — удалить чат из белого списка",
            "• /tester @user или ID — выдать тестер",
            "• /untester @user или ID — забрать тестер",
            "• /vip @user или ID — выдать VIP",
            "• /unvip @user или ID — забрать VIP",
            "• /ban @user или ID — глобальный бан в боте",
            "• /unban @user или ID — снять бан в боте",
            "• /banlist — список забаненных",
            "• /players — список пользователей",
            "Перешли сообщение человека или чата — бот покажет его ID",
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
    # Мут (ограничение отправки сообщений)
    "мут": "mute", "!мут": "mute", "/мут": "mute", "mute": "mute", "/mute": "mute", "!mute": "mute",
    "замутить": "mute", "!замутить": "mute", "/замутить": "mute", "мьют": "mute", "/мьют": "mute", "!мьют": "mute",
    # Размут (снятие ограничений)
    "размут": "unmute", "!размут": "unmute", "/размут": "unmute", "unmute": "unmute", "/unmute": "unmute", "!unmute": "unmute",
    "размутить": "unmute", "!размутить": "unmute", "/размутить": "unmute", "размьют": "unmute", "/размьют": "unmute",
    # Бан (полная блокировка)
    "бан": "ban", "!бан": "ban", "/бан": "ban", "ban": "ban", "/ban": "ban", "!ban": "ban",
    "забанить": "ban", "!забанить": "ban", "/забанить": "ban",
    "заблокать": "ban", "заблокировать": "ban", "!заблокировать": "ban", "/заблокировать": "ban",
    # Разбан (снятие блокировки)
    "разбан": "unban", "!разбан": "unban", "/разбан": "unban", "unban": "unban", "/unban": "unban", "!unban": "unban",
    "разбанить": "unban", "!разбанить": "unban", "/разбанить": "unban",
    "разблокировать": "unban", "!разблокировать": "unban", "/разблокировать": "unban",
    # Кик (исключение из чата)
    "кик": "kick", "!кик": "kick", "/кик": "kick", "kick": "kick", "/kick": "kick", "!kick": "kick",
    "кикнуть": "kick", "!кикнуть": "kick", "/кикнуть": "kick",
    "выгнать": "kick", "!выгнать": "kick", "/выгнать": "kick",
    "исключить": "kick", "!исключить": "kick", "/исключить": "kick",
    # Варн (предупреждение)
    "варн": "warn", "!варн": "warn", "/варн": "warn", "warn": "warn", "/warn": "warn", "!warn": "warn",
    "пред": "warn", "!пред": "warn", "/пред": "warn",
    "предупреждение": "warn", "!предупреждение": "warn", "/предупреждение": "warn",
    "предупредить": "warn", "!предупредить": "warn", "/предупредить": "warn",
    "заварнить": "warn", "!заварнить": "warn", "/заварнить": "warn",
    # Анварн (снятие предупреждений)
    "анварн": "unwarn", "!анварн": "unwarn", "/анварн": "unwarn", "unwarn": "unwarn", "/unwarn": "unwarn", "!unwarn": "unwarn",
    "разварн": "unwarn", "!разварн": "unwarn", "/разварн": "unwarn", "разварнить": "unwarn",
    "снятьварн": "unwarn", "снятьварны": "unwarn", "!снятьварн": "unwarn", "!снятьварны": "unwarn",
    "снятьпред": "unwarn", "снятьпреды": "unwarn", "!снятьпред": "unwarn",
    # Варны (просмотр количества варнов)
    "варны": "warns", "!варны": "warns", "/варны": "warns", "warns": "warns", "/warns": "warns", "!warns": "warns",
    "преды": "warns", "!преды": "warns", "/преды": "warns",
    "предупреждения": "warns", "варнлист": "warns",
    # Дел (удаление сообщения)
    "дел": "del", "!дел": "del", "/дел": "del", "del": "del", "/del": "del", "!del": "del",
    "удалить": "del", "!удалить": "del", "/удалить": "del",
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
    if "whitelisted_chats" not in data:
        data["whitelisted_chats"] = {}
        # Автоматически вносим текущие сохранённые группы, чтобы не сломать их
        for cid in data.get("chat_topics", {}):
            data["whitelisted_chats"][str(cid)] = {
                "title": "Spore TD Chat",
                "added_at": int(time.time()),
                "added_by": "system",
            }
    if "chat_roles" not in data:
        data["chat_roles"] = {}
    if "goals" not in data:
        data["goals"] = {}
    if "boosts" not in data:
        data["boosts"] = {}
    if "referrals" not in data:
        data["referrals"] = {}
    if "referral_stats" not in data:
        data["referral_stats"] = {}
    if "known_users" not in data:
        data["known_users"] = {}

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
    """Парсит строку вида '10м', '10 мин', '10минут', '2ч', '2 часа', '1д', '3 дня' в количество секунд."""
    if not s:
        return None
    s = s.strip().lower()
    if s in ("навсегда", "forever", "0"):
        return 0
    m = re.match(r"^(\d+)\s*([смчдsmhd]|сек\w*|мин\w*|час\w*|дн\w*|ден\w*|сут\w*)?$", s)
    if not m:
        return None
    val = int(m.group(1))
    u = (m.group(2) or "м").lower()
    if u in ("с", "s") or u.startswith("сек"):
        return max(30, val)
    if u in ("м", "m") or u.startswith("мин"):
        return val * 60
    if u in ("ч", "h") or u.startswith("час"):
        return val * 3600
    if u in ("д", "d") or u.startswith("дн") or u.startswith("ден") or u.startswith("сут"):
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
    if is_creator_user(user_id):
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


# --------------------------- Система рангов и Белый список ---------------------------
RANK_CREATOR = 3
RANK_ADMIN = 2
RANK_MODER = 1
RANK_USER = 0

RANK_NAMES = {
    RANK_CREATOR: "👑 Создатель",
    RANK_ADMIN: "⭐️ Админ",
    RANK_MODER: "🛡 Модер",
    RANK_USER: "👤 Участник",
}

_BOT_INFO = None
def get_bot_info():
    global _BOT_INFO, BOT_USERNAME
    if _BOT_INFO is None:
        try:
            res = api("getMe")
            if res.get("ok") and isinstance(res.get("result"), dict):
                _BOT_INFO = res["result"]
                if _BOT_INFO.get("username"):
                    BOT_USERNAME = _BOT_INFO["username"]
        except Exception:
            pass
    return _BOT_INFO or {}

_KNOWN_USERS = {}  # username.lower() -> (user_id_str, display_name)
_CHAT_ADMINS_CACHE = {}  # str(chat_id) -> (admins_dict, timestamp)

try:
    _init_known = load_mod_data().get("known_users", {})
    if isinstance(_init_known, dict):
        for k, v in _init_known.items():
            if isinstance(v, (list, tuple)) and len(v) >= 2:
                _KNOWN_USERS[str(k).lower().lstrip("@")] = (str(v[0]), str(v[1]))
except Exception:
    pass


def register_known_user(user_id, username=None, display_name=None):
    """Надёжно сохраняет соответствие @username <-> ID в память и на диск."""
    if not user_id:
        return
    uid_str = str(user_id).strip()
    mod_data = load_mod_data()
    changed = False

    if "known_users" not in mod_data:
        mod_data["known_users"] = {}
    if "known_users_by_id" not in mod_data:
        mod_data["known_users_by_id"] = {}

    disp = display_name or (f"@{username}" if username else f"ID:{uid_str}")

    if username:
        uname = str(username).lower().lstrip("@").strip()
        if uname:
            u_entry = [uid_str, disp]
            if mod_data["known_users"].get(uname) != u_entry:
                mod_data["known_users"][uname] = u_entry
                changed = True
            _KNOWN_USERS[uname] = (uid_str, disp)

    if mod_data["known_users_by_id"].get(uid_str) != disp:
        mod_data["known_users_by_id"][uid_str] = disp
        changed = True

    if changed:
        save_mod_data(mod_data)


def get_chat_admins_dict(chat_id, force=False):
    """Возвращает кэшированный словарь администраторов чата для быстрого доступа без задержек."""
    global _CHAT_ADMINS_CACHE, _KNOWN_USERS
    cid_str = str(chat_id).strip()
    now = time.time()
    if not force and cid_str in _CHAT_ADMINS_CACHE:
        entry, ts = _CHAT_ADMINS_CACHE[cid_str]
        if (now - ts) < 60:
            return entry

    admins_dict = {}
    try:
        res = api("getChatAdministrators", chat_id=chat_id)
        if res.get("ok"):
            for m in res.get("result", []):
                u = m.get("user", {})
                uid = str(u.get("id"))
                st = m.get("status")
                rank = RANK_CREATOR if st == "creator" else RANK_ADMIN
                admins_dict[uid] = rank
                uname = u.get("username")
                disp = f"@{uname}" if uname else (u.get("first_name") or f"ID:{uid}")
                if uname:
                    uname_lower = uname.lower().lstrip("@")
                    u_tuple = (uid, disp)
                    admins_dict[uname_lower] = u_tuple
                    _KNOWN_USERS[uname_lower] = u_tuple
                register_known_user(uid, uname, disp)
            _CHAT_ADMINS_CACHE[cid_str] = (admins_dict, now)
            return admins_dict
    except Exception as e:
        print(f"[WARN] getChatAdministrators error: {e}")

    if cid_str in _CHAT_ADMINS_CACHE:
        return _CHAT_ADMINS_CACHE[cid_str][0]
    return {}


def get_user_chat_rank(chat_id, user_id, username=None):
    """Определяет ранг участника в чате:
    3 - Создатель (глобальный владелец бота или создатель группы в Telegram)
    2 - Админ (назначенный создателем или администратор группы в Telegram)
    1 - Модер (назначенный админом или создателем)
    0 - Участник
    """
    if is_creator_user(user_id, username):
        return RANK_CREATOR

    cid_str = str(chat_id).strip()
    uid_str = str(user_id).strip()

    mod_data = load_mod_data()
    saved_roles = {}
    for cand in normalize_chat_candidates(chat_id):
        if cand in mod_data.get("chat_roles", {}):
            saved_roles = mod_data["chat_roles"][cand]
            break

    explicit_role = saved_roles.get(uid_str) or saved_roles.get(int(uid_str) if uid_str.isdigit() else uid_str)
    if isinstance(explicit_role, dict):
        explicit_role = explicit_role.get("role")
    if explicit_role == "creator":
        return RANK_CREATOR
    if explicit_role == "admin":
        return RANK_ADMIN
    if explicit_role == "moder":
        return RANK_MODER
    if explicit_role in ("user", "none", "demoted"):
        return RANK_USER

    # Проверяем кэшированных администраторов Telegram-чата
    admins = get_chat_admins_dict(chat_id)
    if uid_str in admins:
        return admins[uid_str]
    if username:
        uname_clean = str(username).lower().lstrip("@")
        if uname_clean in admins and isinstance(admins[uname_clean], tuple):
            admin_uid = admins[uname_clean][0]
            if admin_uid in admins:
                return admins[admin_uid]

    # Fallback на getChatMember если getChatAdministrators не вернул пользователя
    if is_chat_admin(chat_id, user_id):
        return RANK_ADMIN

    return RANK_USER


def set_chat_role(chat_id, user_id, role, set_by="creator", target_name=None):
    """Назначает роль в чате ('admin', 'moder', 'user')."""
    mod_data = load_mod_data()
    cid_str = str(chat_id).strip()
    uid_str = str(user_id).strip()
    if "chat_roles" not in mod_data:
        mod_data["chat_roles"] = {}
    if cid_str not in mod_data["chat_roles"]:
        mod_data["chat_roles"][cid_str] = {}
    mod_data["chat_roles"][cid_str][uid_str] = role
    if target_name:
        register_known_user(uid_str, target_name.lstrip("@") if target_name.startswith("@") else None, target_name)
    save_mod_data(mod_data)
    return True


def remove_chat_role(chat_id, user_id):
    """Удаляет назначенную роль в чате."""
    mod_data = load_mod_data()
    uid_str = str(user_id).strip()
    removed = False
    for cand in normalize_chat_candidates(chat_id):
        if "chat_roles" in mod_data and cand in mod_data["chat_roles"]:
            if uid_str in mod_data["chat_roles"][cand]:
                del mod_data["chat_roles"][cand][uid_str]
                removed = True
            if uid_str.isdigit() and int(uid_str) in mod_data["chat_roles"][cand]:
                del mod_data["chat_roles"][cand][int(uid_str)]
                removed = True
    if removed:
        save_mod_data(mod_data)
        return True
    return False


def normalize_chat_candidates(chat_id):
    """Генерирует все возможные варианты ID/псевдонима чата для надёжного сопоставления."""
    if not chat_id:
        return []
    s = str(chat_id).strip()
    candidates = {s, s.lower()}
    clean = s.lstrip("@").lower()
    candidates.add(clean)
    if not clean.startswith("-"):
        candidates.add(f"@{clean}")

    # Ссылки t.me
    if "t.me/" in s:
        if "/c/" in s:
            m = re.search(r"/c/(\d+)", s)
            if m:
                candidates.add(f"-100{m.group(1)}")
                candidates.add(m.group(1))
        else:
            m = re.search(r"t\.me/([a-zA-Z0-9_]+)", s)
            if m:
                u = m.group(1).lower()
                candidates.add(f"@{u}")
                candidates.add(u)

    # Числовые вариации (-100xxx, -xxx, xxx)
    num_part = s.lstrip("-")
    if num_part.isdigit():
        if num_part.startswith("100") and len(num_part) > 3:
            raw = num_part[3:]
            candidates.update([f"-100{raw}", f"-{raw}", raw, f"100{raw}"])
        else:
            candidates.update([f"-100{num_part}", f"-{num_part}", num_part])

    return list(candidates)


def is_chat_whitelisted(chat_id):
    """Проверяет, находится ли чат в белом списке разрешённых."""
    if not chat_id:
        return False
    mod_data = load_mod_data()
    wl = mod_data.get("whitelisted_chats", {})
    for c in normalize_chat_candidates(chat_id):
        if c in wl:
            return True
    return False


def add_whitelisted_chat(chat_id, title=None, added_by="creator"):
    """Добавляет чат в белый список. Поддерживает ID, @username и ссылки t.me."""
    mod_data = load_mod_data()
    if "whitelisted_chats" not in mod_data:
        mod_data["whitelisted_chats"] = {}

    target = str(chat_id).strip()
    if "t.me/" in target:
        if "/c/" in target:
            m = re.search(r"/c/(\d+)", target)
            if m:
                target = f"-100{m.group(1)}"
        else:
            m = re.search(r"t\.me/([a-zA-Z0-9_]+)", target)
            if m:
                target = f"@{m.group(1)}"

    resolved_id = target
    resolved_title = title

    try:
        cinfo = api("getChat", chat_id=target)
        if cinfo.get("ok"):
            res = cinfo["result"]
            resolved_id = str(res.get("id"))
            if not resolved_title:
                resolved_title = res.get("title") or res.get("username")
    except Exception as e:
        print(f"[WARN] add_whitelisted_chat getChat error: {e}")

    cid_str = str(resolved_id)
    final_title = resolved_title or title or f"Чат {cid_str}"

    mod_data["whitelisted_chats"][cid_str] = {
        "title": final_title,
        "added_at": int(time.time()),
        "added_by": str(added_by),
    }

    # Добавляем все кандидаты псевдонимов
    for cand in normalize_chat_candidates(target):
        if cand != cid_str:
            mod_data["whitelisted_chats"][cand] = {
                "title": final_title,
                "target_id": cid_str,
                "added_at": int(time.time()),
                "added_by": str(added_by),
            }

    save_mod_data(mod_data)
    return cid_str, final_title


def remove_whitelisted_chat(chat_id):
    """Удаляет чат из белого списка."""
    mod_data = load_mod_data()
    removed = False

    if "whitelisted_chats" in mod_data:
        targets_to_remove = normalize_chat_candidates(chat_id)
        for t in targets_to_remove:
            if t in mod_data["whitelisted_chats"]:
                entry = mod_data["whitelisted_chats"].pop(t)
                removed = True
                if isinstance(entry, dict) and "target_id" in entry:
                    mod_data["whitelisted_chats"].pop(entry["target_id"], None)

        for k, v in list(mod_data["whitelisted_chats"].items()):
            if isinstance(v, dict) and v.get("target_id") in targets_to_remove:
                del mod_data["whitelisted_chats"][k]
                removed = True

    if removed:
        save_mod_data(mod_data)
        return True
    return False


def resolve_command_target(message, args, chat_id=None):
    """
    Универсальное определение целевого пользователя для команд:
    1. По ответу на сообщение (reply_to_message)
    2. По сущности text_mention в сообщении или подписи
    3. По аргументу: @username или числовой ID (на любой позиции)
    Возвращает кортеж: (target_id, target_name, remaining_args, error_msg)
    """
    global _KNOWN_USERS
    reply_to = message.get("reply_to_message")
    if reply_to and not reply_to.get("forum_topic_created"):
        user = reply_to.get("from", {})
        target_id = user.get("id")
        u_name = user.get("username")
        first_name = user.get("first_name")
        target_name = f"@{u_name}" if u_name else (first_name or f"ID:{target_id}")
        if target_id and u_name:
            register_known_user(target_id, u_name, target_name)
        # Очищаем переданные в тексте дублирующие упоминания цели, чтобы они не загрязняли причину
        rem = []
        for a in args:
            clean_a = a.lstrip("@").lower()
            if u_name and clean_a == u_name.lower():
                continue
            if target_id and a == str(target_id):
                continue
            rem.append(a)
        return target_id, target_name, rem, None

    # Проверяем сущности text_mention в тексте и подписи к медиа
    all_entities = list(message.get("entities", [])) + list(message.get("caption_entities", []))
    m_text = (message.get("text") or message.get("caption") or "")
    for ent in all_entities:
        if ent.get("type") == "text_mention" and ent.get("user"):
            u = ent["user"]
            target_id = u.get("id")
            u_name = u.get("username")
            target_name = f"@{u_name}" if u_name else (u.get("first_name") or f"ID:{target_id}")
            if target_id:
                register_known_user(target_id, u_name, target_name)
            off = ent.get("offset", 0)
            lng = ent.get("length", 0)
            mention_word = m_text[off:off+lng]
            rem = [a for a in args if a != mention_word and not (u_name and a.lstrip("@").lower() == u_name.lower())]
            return target_id, target_name, rem, None
            return target_id, target_name, rem, None

    # Проверяем аргументы: В ПЕРВУЮ ОЧЕРЕДЬ ищем токен, начинающийся с @
    target_token = None
    target_idx = -1
    for idx, a in enumerate(args):
        if a.startswith("@"):
            target_token = a
            target_idx = idx
            break

    # Если @username не указан, ищем числовой ID
    if target_token is None:
        for idx, a in enumerate(args):
            if a.isdigit() and len(a) >= 5:
                target_token = a
                target_idx = idx
                break
        if target_token is None:
            for idx, a in enumerate(args):
                if a.isdigit() and parse_time_str(a) is None:
                    target_token = a
                    target_idx = idx
                    break

    if target_token is not None:
        remaining_args = [a for i, a in enumerate(args) if i != target_idx]
        if target_token.isdigit():
            target_id = int(target_token)
            mod_data = load_mod_data()
            known_name = mod_data.get("known_users_by_id", {}).get(str(target_id))
            target_name = known_name or f"ID:{target_id}"
            return target_id, target_name, remaining_args, None

        uname = target_token.lstrip("@").lower()
        target_name = f"@{uname}"

        # 1. Память
        if uname in _KNOWN_USERS:
            target_id = int(_KNOWN_USERS[uname][0])
            return target_id, target_name, remaining_args, None

        # 2. Файл / кэш модерации
        mod_data = load_mod_data()
        if uname in mod_data.get("known_users", {}):
            target_id = int(mod_data["known_users"][uname][0])
            _KNOWN_USERS[uname] = tuple(mod_data["known_users"][uname])
            return target_id, target_name, remaining_args, None

        # 3. Администраторы чата
        if chat_id:
            admins = get_chat_admins_dict(chat_id, force=True)
            if uname in admins and isinstance(admins[uname], tuple):
                target_id = int(admins[uname][0])
                register_known_user(target_id, uname, target_name)
                return target_id, target_name, remaining_args, None

        # 4. База игроков TD
        doc_id, _ = resolve_target(f"@{uname}")
        if doc_id and str(doc_id).isdigit():
            target_id = int(doc_id)
            register_known_user(target_id, uname, target_name)
            return target_id, target_name, remaining_args, None

        return None, target_name, remaining_args, (
            f"⚠️ Пользователь @{uname} пока не зафиксирован ботом в этом чате.\n"
            f"Чтобы применить команду, ответьте (reply) на его сообщение или укажите его ID (`команда ID`)."
        )

    return None, None, args, "ℹ️ Ответьте на сообщение пользователя или укажите: `команда @username` (или ID)."


def render_progress_bar(current, target, length=10):
    """Рисует визуальный прогресс-бар: [██████░░░░] 60%"""
    if target <= 0:
        return "[░░░░░░░░░░] 0%"
    pct = min(100, max(0, int((current / target) * 100)))
    filled = int(round(length * (pct / 100.0)))
    bar = "█" * filled + "░" * (length - filled)
    return f"[{bar}] {pct}%"


def get_chat_goal(chat_id):
    mod_data = load_mod_data()
    for cand in normalize_chat_candidates(chat_id):
        if cand in mod_data.get("goals", {}):
            return mod_data["goals"][cand]
    return None


def set_chat_goal(chat_id, target, title, unit=None, set_by=None):
    mod_data = load_mod_data()
    if "goals" not in mod_data:
        mod_data["goals"] = {}
    cid_str = str(chat_id).strip()

    actual_unit = unit
    if not actual_unit:
        words = title.strip().split()
        actual_unit = words[0] if words else "очков"

    goal_entry = {
        "title": title,
        "target": target,
        "current": 0,
        "unit": actual_unit,
        "set_by": str(set_by) if set_by else None,
        "updated_at": int(time.time()),
    }
    mod_data["goals"][cid_str] = goal_entry
    for cand in normalize_chat_candidates(chat_id):
        if cand != cid_str and cand in mod_data["goals"]:
            del mod_data["goals"][cand]
    save_mod_data(mod_data)
    return True


def add_goal_progress(chat_id, amount):
    mod_data = load_mod_data()
    for cand in normalize_chat_candidates(chat_id):
        if cand in mod_data.get("goals", {}):
            goal = mod_data["goals"][cand]
            goal["current"] = max(0, goal.get("current", 0) + amount)
            goal["updated_at"] = int(time.time())
            save_mod_data(mod_data)
            return True
    return False


def reset_chat_goal(chat_id):
    mod_data = load_mod_data()
    removed = False
    for cand in normalize_chat_candidates(chat_id):
        if "goals" in mod_data and cand in mod_data["goals"]:
            del mod_data["goals"][cand]
            removed = True
    if removed:
        save_mod_data(mod_data)
        return True
    return False


def render_goal_text(chat_id):
    goal = get_chat_goal(chat_id)
    if not goal:
        return (
            "🎯 *Цель сообщества не установлена.*\n\n"
            "⭐️ Администратор может установить её командой:\n"
            "`/goal [число] [описание]` или `сетцель [число] [описание]`\n\n"
            "_Пример:_ `/goal 500 участников` или `сетцель 1000 звёзд на турнир`"
        )
    cur = goal.get("current", 0)
    tgt = goal.get("target", 1)
    bar_str = render_progress_bar(cur, tgt)
    title = goal.get("title", "Цель сообщества")
    unit = goal.get("unit", "")
    return (
        f"🎯 *Цель чата:* {title}\n\n"
        f"📊 Прогресс: `{bar_str}`\n"
        f"📈 Собрано: *{cur}* из *{tgt}* {unit}\n\n"
        f"_Управление (Админ+):_ `+прогресс [число]`, `/goal +[число]` или `/goal reset`"
    )


def get_chat_boost(chat_id):
    mod_data = load_mod_data()
    for cand in normalize_chat_candidates(chat_id):
        if cand in mod_data.get("boosts", {}):
            return mod_data["boosts"][cand]
    return {"level": 1, "points": 0}


def add_chat_boost(chat_id, points):
    mod_data = load_mod_data()
    if "boosts" not in mod_data:
        mod_data["boosts"] = {}
    cid_str = str(chat_id).strip()
    b = get_chat_boost(chat_id)
    b["points"] = max(0, b.get("points", 0) + points)
    if b["points"] >= 300:
        b["level"] = 3
    elif b["points"] >= 100:
        b["level"] = 2
    else:
        b["level"] = 1
    mod_data["boosts"][cid_str] = b
    for cand in normalize_chat_candidates(chat_id):
        if cand != cid_str and cand in mod_data["boosts"]:
            del mod_data["boosts"][cand]
    save_mod_data(mod_data)
    return b


def reset_chat_boost(chat_id):
    """Сбрасывает буст чата к исходному уровню."""
    mod_data = load_mod_data()
    removed = False
    for cand in normalize_chat_candidates(chat_id):
        if "boosts" in mod_data and cand in mod_data["boosts"]:
            del mod_data["boosts"][cand]
            removed = True
    if removed:
        save_mod_data(mod_data)
        return True
    return False


def render_boost_text(chat_id):
    b = get_chat_boost(chat_id)
    lvl = b.get("level", 1)
    pts = b.get("points", 0)
    if lvl == 1:
        need = 100
        perks = "• Базовая модерация\n• Символьная капча\n• Антиспам 3/3 варна"
    elif lvl == 2:
        need = 300
        perks = "• Все перки Уровня 1\n• +5% биомассы всем участникам чата в Spore TD\n• Кастомные теги в чате"
    else:
        need = 1000
        perks = "• Все перки Уровней 1-2\n• +15% биомассы в Spore TD\n• Золотой значок сообщества\n• Закрытый еженедельный сид-турнир"

    bar = render_progress_bar(pts, need)
    return (
        f"⚡ *Буст сообщества: Уровень {lvl}*\n\n"
        f"📈 Очки прокачки: *{pts}* / *{need}*\n"
        f"📊 Прогресс: `{bar}`\n\n"
        f"🎁 *Активные перки уровня:*\n{perks}\n\n"
        f"💡 _Как бустить:_ бусты группы Telegram Premium, активная игра в Spore TD или команда `/boost [число]` / `+буст [число]` (Админ+)."
    )


# --------------------------- Реферальная система ---------------------------
def get_referral_link(user_id):
    """Генерирует персональную реферальную ссылку игрока."""
    return f"https://t.me/{BOT_USERNAME}?start=ref_{user_id}"


def get_user_referral_stats(user_id):
    """Возвращает статистику рефералов пользователя."""
    mod_data = load_mod_data()
    uid = str(user_id).strip()
    stats = mod_data.get("referral_stats", {}).get(uid, {})
    ref_info = mod_data.get("referrals", {}).get(uid, {})
    return {
        "count": stats.get("count", 0),
        "biomass": stats.get("biomass", 0),
        "invited_users": stats.get("invited_users", []),
        "referrer": ref_info.get("referrer"),
    }


def register_referral(new_user_id, referrer_id, new_username=None):
    """Регистрирует реферала при переходе по ссылке start=ref_USERID.
    Возвращает кортеж (success: bool, reason: str, info: dict).
    """
    new_uid = str(new_user_id).strip()
    ref_uid = str(referrer_id).strip()

    if not new_uid or not ref_uid:
        return False, "invalid_ids", None

    if not new_uid.isdigit() or int(new_uid) <= 0 or not ref_uid.isdigit() or int(ref_uid) <= 0:
        return False, "invalid_ids", None

    if new_uid == ref_uid:
        return False, "self_referral", None

    if ref_uid in load_banned_ids():
        return False, "banned_referrer", None

    mod_data = load_mod_data()
    if "referrals" not in mod_data:
        mod_data["referrals"] = {}
    if "referral_stats" not in mod_data:
        mod_data["referral_stats"] = {}

    if new_uid in mod_data["referrals"]:
        return False, "already_referred", mod_data["referrals"][new_uid]

    # Защита от взаимных циклов (A пригласил B, B не может пригласить A)
    ref_info = mod_data.get("referrals", {}).get(ref_uid, {})
    if ref_info.get("referrer") == new_uid:
        return False, "mutual_referral", None

    if ref_uid in mod_data.get("referral_stats", {}).get(new_uid, {}).get("invited_users", []):
        return False, "mutual_referral", None

    # Игрок, уже приглашавший других, считается опытным и не может активировать чужой инвайт
    if mod_data.get("referral_stats", {}).get(new_uid, {}).get("count", 0) > 0:
        return False, "already_referred", None

    if db is not None:
        try:
            user_doc = db.collection("users").document(new_uid).get()
            if user_doc.exists and user_doc.to_dict().get("referrer"):
                return False, "already_referred", user_doc.to_dict()
        except Exception as e:
            print("[WARN] Firestore user check error:", e)

    mod_data["referrals"][new_uid] = {
        "referrer": ref_uid,
        "joined_at": int(time.time()),
        "reward": 50,
        "username": new_username or "",
    }

    r_stats = mod_data["referral_stats"].setdefault(ref_uid, {
        "count": 0,
        "biomass": 0,
        "invited_users": [],
    })
    r_stats["count"] = r_stats.get("count", 0) + 1
    r_stats["biomass"] = r_stats.get("biomass", 0) + 50
    if new_uid not in r_stats.get("invited_users", []):
        r_stats.setdefault("invited_users", []).append(new_uid)

    save_mod_data(mod_data)

    if db is not None:
        try:
            db.collection("users").document(new_uid).set({
                "referrer": ref_uid,
                "referral_bonus": 50,
            }, merge=True)
            ref_doc = db.collection("users").document(ref_uid).get()
            cur_biomass = 0
            if ref_doc.exists:
                cur_biomass = (ref_doc.to_dict() or {}).get("referral_biomass", 0)
            db.collection("users").document(ref_uid).set({
                "referral_biomass": cur_biomass + 50,
                "referral_count": r_stats["count"],
            }, merge=True)
        except Exception as e:
            print("[WARN] Firestore referral sync error:", e)

    return True, "success", {"referrer": ref_uid, "count": r_stats["count"], "reward": 50}


def render_referral_card(user_id, username=None):
    """Генерирует текст карточки реферальной системы."""
    stats = get_user_referral_stats(user_id)
    ref_link = get_referral_link(user_id)
    lines = [
        "🎁 *Реферальная программа Spore TD*",
        "",
        "Приглашай друзей в ряды обороны лаборатории S.A.M. и получай биомассу на рероллы башен!",
        "",
        "• *Новичок:* получает *+50 🧬 биомассы* на старте",
        "• *Ты получаешь:* *+50 🧬 биомассы* за каждого приглашённого друга",
        "",
        f"🔗 *Твоя реферальная ссылка:*\n`{ref_link}`",
        "",
        "📊 *Твоя статистика:*",
        f"👥 Приглашено друзей: *{stats['count']}*",
        f"🧬 Заработано биомассы: *{stats['biomass']}*",
    ]
    if stats.get("referrer"):
        lines.append(f"👤 Твой пригласитель: `{stats['referrer']}`")
    return "\n".join(lines)


def handle_referral_command(message):
    """Обрабатывает команду рефералов (/ref, реферал) — временно отключена."""
    chat = message.get("chat", {})
    chat_id = chat.get("id")
    thread_id = message.get("message_thread_id")
    message_id = message.get("message_id")
    notice = "ℹ️ Реферальная система временно отключена на время балансировки экономики и золота."
    if chat.get("type") in ("group", "supergroup"):
        send_group_msg(chat_id, notice, thread_id=thread_id, reply_to=message_id)
    else:
        send_message(chat_id, notice)


def handle_new_chat_members(chat_id, new_members, message_id=None, message_thread_id=None):
    """Ограничивает нового участника и отправляет сообщение-помощник с кнопкой проверки."""
    if not is_chat_whitelisted(chat_id):
        return

    mod_data = load_mod_data()

    # Топик берём строго из сохранённых настроек группы, чтобы не писать в разные темы
    target_thread = mod_data.get("chat_topics", {}).get(str(chat_id))

    for member in new_members:
        if member.get("is_bot"):
            continue
        uid = member["id"]
        first_name = member.get("first_name") or "Новичок"

        # Создателя и модераторов группы никогда не ограничиваем и не вызываем для них капчу
        if str(uid) == str(CREATOR_ID) or get_user_chat_rank(chat_id, uid) >= RANK_MODER:
            print(f"[CAPTCHA] Skipping staff/creator {uid} ({first_name}) in chat {chat_id}")
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

        res = send_group_msg(chat_id, text, thread_id=target_thread, keyboard=keyboard)
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
    """Событие изменения участника (вход через канал, инвайт, сообщество, перезаход)."""
    old_cm = cm.get("old_chat_member", {})
    new_cm = cm.get("new_chat_member", {})
    from_u = cm.get("from", {})

    # Гарантированно фиксируем всех участников события в базе и кэше бота (как Iris)
    for u in (new_cm.get("user"), old_cm.get("user"), from_u):
        if u and isinstance(u, dict) and not u.get("is_bot") and u.get("id"):
            register_known_user(u.get("id"), u.get("username"), u.get("first_name"))

    chat = cm.get("chat", {})
    chat_id = chat.get("id")
    chat_type = chat.get("type", "")
    if chat_type not in ("group", "supergroup"):
        return

    if not is_chat_whitelisted(chat_id):
        return

    old_status = old_cm.get("status")
    new_status = new_cm.get("status")
    old_is_member = old_cm.get("is_member", False)
    new_is_member = new_cm.get("is_member", True)
    new_user = new_cm.get("user", {})

    if not new_user or new_user.get("is_bot"):
        return

    uid = new_user.get("id")
    if is_creator_user(uid, new_user.get("username")) or is_chat_admin(chat_id, uid):
        return

    print(f"[CHAT_MEMBER] Chat {chat_id}: user {uid} ({new_user.get('first_name')}) status {old_status} (member={old_is_member}) -> {new_status} (member={new_is_member})")

    # Если участник покинул чат
    if new_status in ("left", "kicked") or (not new_is_member and old_is_member):
        mod_data = load_mod_data()
        key = f"{chat_id}_{uid}"
        if key in mod_data.get("pending_captcha", {}):
            mod_data["pending_captcha"].pop(key, None)
            save_mod_data(mod_data)
        return

    # Вход или повторный вход в чат
    was_not_in_chat = old_status in ("left", "kicked", None) or not old_is_member
    is_now_in_chat = new_status in ("member", "restricted") and new_is_member

    if was_not_in_chat and is_now_in_chat:
        handle_new_chat_members(chat_id, [new_user], message_id=None, message_thread_id=None)
        return

    # Если уже был в pending_captcha и переподключился
    mod_data = load_mod_data()
    key = f"{chat_id}_{uid}"
    if key in mod_data.get("pending_captcha", {}) and is_now_in_chat:
        handle_new_chat_members(chat_id, [new_user], message_id=None, message_thread_id=None)


def handle_my_chat_member_update(mcm):
    """Событие добавления или изменения прав самого бота в чате."""
    inviter = mcm.get("from", {})
    if inviter and not inviter.get("is_bot") and inviter.get("id"):
        register_known_user(inviter.get("id"), inviter.get("username"), inviter.get("first_name"))

    chat = mcm.get("chat", {})
    chat_id = chat.get("id")
    chat_title = chat.get("title") or chat.get("username") or str(chat_id)
    chat_type = chat.get("type", "")
    new_cm = mcm.get("new_chat_member", {})
    new_status = new_cm.get("status")

    if chat_type in ("group", "supergroup"):
        if new_status in ("member", "administrator"):
            if not is_chat_whitelisted(chat_id):
                inviter = mcm.get("from", {})
                inviter_name = inviter.get("first_name") or inviter.get("username") or "Пользователь"
                inviter_id = inviter.get("id")
                send_message(
                    CREATOR_ID,
                    f"🔔 *Бот добавлен в новую группу:*\n"
                    f"• Название: *{chat_title}*\n"
                    f"• ID чата: `{chat_id}`\n"
                    f"• Добавил: *{inviter_name}* (`{inviter_id}`)\n\n"
                    f"➕ Добавить группу в белый список?",
                    keyboard={
                        "inline_keyboard": [
                            [{"text": f"➕ Добавить {chat_title[:20]} в вайтлист", "callback_data": f"add_chat:{chat_id}"}]
                        ]
                    }
                )
            else:
                send_group_msg(
                    chat_id,
                    f"👋 SporeTD Bot активен в чате *{chat_title}*!\n"
                    f"Напишите `помощь` или `правила` для списка возможностей."
                )


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
            "Ограничения в группе сняты — добро пожаловать в чат!"
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
        print(f"[GROUP_MSG] Initial send error (thread={thread_id}, reply={reply_to}): {res}")
        if any(k in desc for k in ("reply", "replied")) and "not found" in desc:
            payload.pop("reply_to_message_id", None)
            res = api("sendMessage", **payload)
            desc = res.get("description", "").lower()
        if not res.get("ok") and "can't parse entities" in desc:
            payload.pop("parse_mode", None)
            res = api("sendMessage", **payload)
            desc = res.get("description", "").lower()
        if not res.get("ok") and thread_id and any(k in desc for k in ("thread not found", "message thread not found", "top_message")):
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
    sender_uname = sender.get("username")
    message_id = message.get("message_id")
    reply_to = message.get("reply_to_message")

    def msg_reply(text):
        return send_group_msg(chat_id, text, thread_id=thread_id, reply_to=message_id)

    actor_rank = get_user_chat_rank(chat_id, sender_id, sender_uname)

    # Проверка варнов доступна всем участникам
    if cmd == "warns":
        mod_data = load_mod_data()
        target_id, target_name, _, _ = resolve_command_target(message, args, chat_id)
        check_uid = target_id if target_id else sender_id
        check_name = target_name if target_id else (f"@{sender_uname}" if sender_uname else (sender.get("first_name") or f"ID:{sender_id}"))

        warn_key = f"{chat_id}_{check_uid}"
        current_warns = mod_data.get("warns", {}).get(warn_key, 0)
        if str(check_uid) == str(sender_id):
            if current_warns > 0:
                msg_reply(f"⚠️ У вас *{current_warns}/3* активных предупреждений.")
            else:
                msg_reply("✅ У вас нет активных предупреждений.")
        else:
            if current_warns > 0:
                msg_reply(f"⚠️ У пользователя *{check_name}* сейчас *{current_warns}/3* активных предупреждений.")
            else:
                msg_reply(f"✅ У пользователя *{check_name}* нет активных предупреждений.")
        return

    # Проверка минимального ранга для команды
    if cmd in ("ban", "unban"):
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Команда бана/разбана доступна только ⭐️ Админам и 👑 Создателю.")
            return
    else:
        if actor_rank < RANK_MODER:
            msg_reply("⛔ Команда модерации доступна от ранга 🛡 Модер.")
            return

    if cmd == "del":
        if reply_to and not reply_to.get("forum_topic_created"):
            del_target_u = reply_to.get("from", {})
            del_target_id = del_target_u.get("id")
            del_target_rank = get_user_chat_rank(chat_id, del_target_id, del_target_u.get("username"))
            if not del_target_id and reply_to.get("sender_chat", {}).get("id") == chat_id:
                del_target_rank = RANK_ADMIN
            if del_target_rank == RANK_CREATOR:
                msg_reply("👑 Нельзя удалить сообщение Создателя.")
                return
            if actor_rank <= del_target_rank and actor_rank < RANK_CREATOR:
                msg_reply(f"⚠️ Вы не можете удалить сообщение участника с равным или более высоким рангом ({RANK_NAMES.get(del_target_rank, 'Участник')}).")
                return
            api("deleteMessage", chat_id=chat_id, message_id=reply_to.get("message_id"))
            api("deleteMessage", chat_id=chat_id, message_id=message_id)
        else:
            msg_reply("ℹ️ Ответьте на сообщение нарушителя командой `дел`")
        return

    target_id, target_name, remaining_args, err = resolve_command_target(message, args, chat_id)
    if not target_id:
        msg_reply(err or "ℹ️ Ответьте на сообщение нарушителя или укажите: `команда @username`")
        return

    bot_info = get_bot_info()
    bot_id = bot_info.get("id")
    if bot_id and target_id == bot_id:
        msg_reply("🤖 Нельзя применить команду к боту.")
        return

    if is_creator_user(target_id, target_name):
        msg_reply("👑 Нельзя применить действие к Создателю.")
        return

    target_rank = get_user_chat_rank(chat_id, target_id, target_name)
    if target_rank == RANK_CREATOR:
        msg_reply("👑 Нельзя применить действие к Создателю.")
        return

    if actor_rank <= target_rank and actor_rank < RANK_CREATOR:
        msg_reply(f"⚠️ Вы не можете наказать участника с равным или более высоким рангом ({RANK_NAMES.get(target_rank, 'Участник')}).")
        return

    duration = None
    reason_parts = []
    i = 0
    while i < len(remaining_args):
        combined_time = None
        if duration is None and i + 1 < len(remaining_args):
            combined_time = parse_time_str(f"{remaining_args[i]} {remaining_args[i+1]}")
        if combined_time is not None:
            duration = combined_time
            i += 2
            continue

        sec = parse_time_str(remaining_args[i]) if duration is None else None
        if sec is not None:
            duration = sec
            i += 1
        else:
            reason_parts.append(remaining_args[i])
            i += 1

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


def handle_role_command(message, subcmd, args):
    """Обрабатывает команды управления системой 'создатель, админ, модер'."""
    chat_id = message["chat"]["id"]
    thread_id = message.get("message_thread_id")
    sender = message.get("from", {})
    sender_id = sender.get("id")
    sender_uname = sender.get("username")
    message_id = message.get("message_id")
    reply_to = message.get("reply_to_message")

    def msg_reply(text):
        return send_group_msg(chat_id, text, thread_id=thread_id, reply_to=message_id)

    actor_rank = get_user_chat_rank(chat_id, sender_id, sender_uname)

    # Информационные команды (доступны всем)
    if subcmd in ("my_rank", "ранг", "мой ранг", "мойранг", "кто я", "ктоя", "whoami", "rank", "статус"):
        role_label = RANK_NAMES.get(actor_rank, "👤 Участник")
        perms_desc = {
            RANK_CREATOR: "Полный доступ (вайтлист, назначение админов/модеров, бан, кик, мут, варн, настройки)",
            RANK_ADMIN: "Управление модераторами, бан, разбан, кик, мут, варн, капча, топики, цели, буст",
            RANK_MODER: "Оперативная модерация (кик, мут, размут, варн, анварн, дел, вызов капчи)",
            RANK_USER: "Базовые права (просмотр правил, целей, буста и топа рекордов)",
        }.get(actor_rank, "")
        user_disp = f"@{sender_uname}" if sender_uname else (sender.get("first_name") or f"ID:{sender_id}")
        msg_reply(f"👤 *Профиль участника:*\n• Имя: *{user_disp}*\n• Ранг: *{role_label}* (Уровень {actor_rank})\n• Доступ: _{perms_desc}_")
        return

    if subcmd in ("staff", "состав", "админы", "модеры", "персонал", "команда", "ранги", "admins", "moders"):
        mod_data = load_mod_data()
        saved_roles = {}
        for cand in normalize_chat_candidates(chat_id):
            if cand in mod_data.get("chat_roles", {}):
                saved_roles = mod_data["chat_roles"][cand]
                break

        lines = [f"👥 *Администрация чата {message.get('chat', {}).get('title', '')}:*\n"]

        # Создатели
        creators = [f"@{CREATOR_USERNAME}"]
        admins_dict = get_chat_admins_dict(chat_id)
        for u_key, val in admins_dict.items():
            if val == RANK_CREATOR and u_key.isdigit():
                c_name = mod_data.get("known_users_by_id", {}).get(u_key)
                if not c_name:
                    c_name = next((f"@{u}" for u, (uid, _) in _KNOWN_USERS.items() if uid == u_key), f"`{u_key}`")
                if c_name not in creators:
                    creators.append(c_name)
        lines.append(f"👑 *Создатель:* {', '.join(creators)}")

        # Админы
        admin_uids = set()
        for uid, r in saved_roles.items():
            role_val = r.get("role") if isinstance(r, dict) else r
            if role_val == "admin":
                admin_uids.add(str(uid))

        # Нативные админы Telegram чата, не разжалованные явно
        for u_key, val in admins_dict.items():
            if val == RANK_ADMIN and u_key.isdigit():
                if str(u_key) not in creators:
                    explicit = saved_roles.get(str(u_key))
                    if isinstance(explicit, dict):
                        explicit = explicit.get("role")
                    if explicit != "user":
                        admin_uids.add(str(u_key))

        admin_names = []
        for a in sorted(admin_uids):
            name = mod_data.get("known_users_by_id", {}).get(a)
            if not name:
                name = next((f"@{u}" for u, (uid, _) in _KNOWN_USERS.items() if uid == a), f"`{a}`")
            admin_names.append(name)

        # Модеры
        moder_uids = set()
        for uid, r in saved_roles.items():
            role_val = r.get("role") if isinstance(r, dict) else r
            if role_val == "moder":
                moder_uids.add(str(uid))

        moder_names = []
        for m in sorted(moder_uids):
            name = mod_data.get("known_users_by_id", {}).get(m)
            if not name:
                name = next((f"@{u}" for u, (uid, _) in _KNOWN_USERS.items() if uid == m), f"`{m}`")
            moder_names.append(name)

        lines.append(f"⭐️ *Администраторы:* {', '.join(admin_names) if admin_names else 'нет назначенных'}")
        lines.append(f"🛡 *Модераторы:* {', '.join(moder_names) if moder_names else 'нет назначенных'}")
        lines.append("\n_Назначение:_ `админ @user` (Создатель), `модер @user` (Админ+)")
        msg_reply("\n".join(lines))
        return

    # Назначение или снятие ролей
    target_id, target_name, remaining_args, err = resolve_command_target(message, args, chat_id)
    if not target_id:
        msg_reply(err or "ℹ️ Ответьте на сообщение пользователя или укажите: `команда @username`")
        return

    bot_info = get_bot_info()
    bot_id = bot_info.get("id")
    if bot_id and target_id == bot_id:
        msg_reply("🤖 Нельзя изменить ранг боту.")
        return

    if is_creator_user(target_id, target_name):
        msg_reply("👑 Нельзя изменить роль Создателя.")
        return

    target_rank = get_user_chat_rank(chat_id, target_id, target_name)

    if subcmd in ("promote", "повысить"):
        if target_rank >= RANK_ADMIN:
            msg_reply(f"⭐️ Пользователь *{target_name}* уже имеет высший ранг ({RANK_NAMES.get(target_rank, 'Администратор')}).")
            return
        if target_rank == RANK_MODER:
            if actor_rank < RANK_CREATOR:
                msg_reply("⛔ Повысить Модератора до Администратора может только 👑 Создатель.")
                return
            set_chat_role(chat_id, target_id, "admin", sender_id, target_name)
            msg_reply(f"⭐️ Пользователь *{target_name}* повышен до Администратора!")
            return
        if target_rank == RANK_USER:
            if actor_rank < RANK_ADMIN:
                msg_reply("⛔ Повышать участников могут ⭐️ Администраторы и 👑 Создатель.")
                return
            set_chat_role(chat_id, target_id, "moder", sender_id, target_name)
            msg_reply(f"🛡 Пользователь *{target_name}* назначен Модератором!")
            return

    if subcmd in ("set_admin", "админ", "+админ", "admin", "+admin", "назначить_админ", "сделать_админ", "setadmin"):
        if actor_rank < RANK_CREATOR:
            msg_reply("⛔ Назначать Администраторов может только 👑 Создатель.")
            return
        set_chat_role(chat_id, target_id, "admin", sender_id, target_name)
        msg_reply(f"⭐️ Пользователю *{target_name}* присвоен ранг *Администратор*!")
        return

    if subcmd in ("unset_admin", "unset_админ", "unset_админа", "-админ", "-admin", "снятьадмин", "снять админ", "снять админа", "разжаловать админ", "разжаловать админа", "unsetadmin"):
        if actor_rank < RANK_CREATOR:
            msg_reply("⛔ Снимать Администраторов может только 👑 Создатель.")
            return
        set_chat_role(chat_id, target_id, "user", sender_id, target_name)
        msg_reply(f"👤 Пользователь *{target_name}* разжалован из Администраторов.")
        return

    if subcmd in ("set_moder", "модер", "+модер", "moder", "+moder", "назначить_модер", "сделать_модер", "setmoder"):
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Назначать Модераторов могут ⭐️ Администраторы и 👑 Создатель.")
            return
        if target_rank >= RANK_ADMIN and actor_rank < RANK_CREATOR:
            msg_reply("⚠️ Нельзя изменить роль Администратора.")
            return
        set_chat_role(chat_id, target_id, "moder", sender_id, target_name)
        msg_reply(f"🛡 Пользователю *{target_name}* присвоен ранг *Модератор*!")
        return

    if subcmd in ("unset_moder", "unset_модер", "unset_модера", "-модер", "-moder", "снятьмодер", "снять модер", "снять модера", "разжаловать модер", "разжаловать модера", "unsetmoder"):
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Снимать Модераторов могут ⭐️ Администраторы и 👑 Создатель.")
            return
        set_chat_role(chat_id, target_id, "user", sender_id, target_name)
        msg_reply(f"👤 Пользователь *{target_name}* разжалован из Модераторов.")
        return

    if subcmd in ("demote", "снять", "разжаловать", "понизить"):
        if target_rank == RANK_CREATOR:
            msg_reply("👑 Нельзя разжаловать Создателя.")
            return
        if target_rank == RANK_ADMIN:
            if actor_rank < RANK_CREATOR:
                msg_reply("⛔ Разжаловать Администратора может только 👑 Создатель.")
                return
            set_chat_role(chat_id, target_id, "user", sender_id, target_name)
            msg_reply(f"👤 С пользователя *{target_name}* сняты полномочия Администратора.")
            return
        if target_rank == RANK_MODER:
            if actor_rank < RANK_ADMIN:
                msg_reply("⛔ Разжаловать Модератора могут ⭐️ Администраторы и 👑 Создатель.")
                return
            set_chat_role(chat_id, target_id, "user", sender_id, target_name)
            msg_reply(f"👤 С пользователя *{target_name}* сняты полномочия Модератора.")
            return
        msg_reply(f"ℹ️ У пользователя *{target_name}* нет особых рангов в боте.")


def handle_goal_command(message, subcmd, args):
    """Обрабатывает команды цели сообщества (/goal)."""
    chat_id = message["chat"]["id"]
    thread_id = message.get("message_thread_id")
    sender = message.get("from", {})
    sender_id = sender.get("id")
    sender_uname = sender.get("username")
    message_id = message.get("message_id")

    def msg_reply(text):
        return send_group_msg(chat_id, text, thread_id=thread_id, reply_to=message_id)

    actor_rank = get_user_chat_rank(chat_id, sender_id, sender_uname)

    # 1. Если аргументов нет — показываем текущую цель
    if not args and subcmd in ("goal", "цель"):
        msg_reply(render_goal_text(chat_id))
        return

    first_arg = args[0].lower() if args else ""

    # 2. Сброс цели (сбросцель, /goal reset, /goal сброс, цель сброс, /resetgoal)
    if subcmd in ("reset_goal", "сбросцель", "resetgoal") or first_arg in ("reset", "сброс", "clear", "удалить", "-"):
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Сбросить цель могут ⭐️ Админы и 👑 Создатель.")
            return
        reset_chat_goal(chat_id)
        msg_reply("🎯 Цель чата сброшена.")
        return

    # 3. Добавление прогресса (+число, add, прогресс, /goal +50, +цель 50)
    is_add = (
        subcmd in ("add_goal", "+прогресс", "прогресс", "+цель", "addgoal")
        or first_arg.startswith("+")
        or first_arg in ("+", "add", "добавить", "прогресс")
    )
    if is_add:
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Добавлять прогресс цели могут ⭐️ Админы и 👑 Создатель.")
            return
        add_str = first_arg
        if first_arg in ("+", "add", "добавить", "прогресс") and len(args) > 1:
            add_str = args[1]
        add_str = add_str.lstrip("+")
        if not add_str.replace("-", "").isdigit():
            msg_reply("ℹ️ Использование: `+прогресс [число]` или `/goal +[число]`\nПример: `/goal +50`")
            return
        add_amount = int(add_str)
        res = add_goal_progress(chat_id, add_amount)
        if not res:
            msg_reply("🎯 Цель чата ещё не установлена. Задайте её: `/goal [число] [описание]`")
            return
        msg_reply(f"📈 Прогресс цели обновлён!\n\n{render_goal_text(chat_id)}")
        return

    # 4. Установка новой цели: сетцель [число] [описание], /goal [число] [описание], /setgoal [число] [описание]
    set_args = args
    if first_arg in ("set", "сет", "установить") and len(args) > 1:
        set_args = args[1:]

    if subcmd in ("set_goal", "сетцель", "setgoal") or (set_args and set_args[0].isdigit()):
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Устанавливать цель чата могут только ⭐️ Админы и 👑 Создатель.")
            return
        if not set_args or not set_args[0].isdigit():
            msg_reply("ℹ️ Использование: `/goal [число] [описание]`\nПример: `/goal 500 участников`")
            return
        target_val = int(set_args[0])
        desc = " ".join(set_args[1:]).strip() or "Цель чата"
        unit = set_args[1].strip() if len(set_args) > 1 else "очков"
        set_chat_goal(chat_id, target_val, desc, unit=unit, set_by=sender_id)
        msg_reply(f"🎯 Новая цель чата установлена:\n*{desc}* — целевое значение: *{target_val}*!\n\n{render_goal_text(chat_id)}")
        return

    msg_reply(render_goal_text(chat_id))


def handle_boost_command(message, subcmd, args):
    """Обрабатывает команды буста сообщества (/boost)."""
    chat_id = message["chat"]["id"]
    thread_id = message.get("message_thread_id")
    sender = message.get("from", {})
    sender_id = sender.get("id")
    sender_uname = sender.get("username")
    message_id = message.get("message_id")

    def msg_reply(text):
        return send_group_msg(chat_id, text, thread_id=thread_id, reply_to=message_id)

    actor_rank = get_user_chat_rank(chat_id, sender_id, sender_uname)

    # 1. Если аргументов нет — показываем текущий уровень буста
    if not args and subcmd in ("boost", "буст"):
        msg_reply(render_boost_text(chat_id))
        return

    first_arg = args[0].lower() if args else ""

    # 2. Сброс буста
    if subcmd in ("reset_boost", "сбросбуст", "resetboost") or first_arg in ("reset", "сброс", "clear", "-"):
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Сбросить буст могут ⭐️ Админы и 👑 Создатель.")
            return
        reset_chat_boost(chat_id)
        msg_reply("⚡ Буст чата сброшен к исходному уровню.")
        return

    # 3. Добавление очков буста (+буст [число], /boost [число], /boost +[число], буст [число], +boost)
    add_str = first_arg.lstrip("+")
    if first_arg in ("add", "добавить", "+") and len(args) > 1:
        add_str = args[1].lstrip("+")

    if subcmd in ("add_boost", "+буст", "+boost", "addboost") or add_str.isdigit():
        if actor_rank < RANK_ADMIN:
            msg_reply("⛔ Добавлять очки буста могут ⭐️ Админы и 👑 Создатель.")
            return
        amount = int(add_str) if add_str.isdigit() else 10
        add_chat_boost(chat_id, amount)
        msg_reply(f"⚡ Очки буста чата увеличены на +*{amount}*!\n\n{render_boost_text(chat_id)}")
        return

    msg_reply(render_boost_text(chat_id))


def render_help_message(chat_id, thread_id=None, reply_to=None):
    """Отправляет структурированное Iris-style меню правил и команд с навигацией."""
    kb = {
        "inline_keyboard": [
            [
                {"text": "🛡 Модерация", "callback_data": "h_mod"},
                {"text": "👑 Ранги", "callback_data": "h_rank"},
            ],
            [
                {"text": "⚙️ Настройки и Топики", "callback_data": "h_set"},
                {"text": "🎯 Цели и Буст", "callback_data": "h_goal"},
            ],
        ]
    }
    text = (
        "📖 *Справочник команд (в стиле Iris CM)*\n\n"
        "💡 _Все команды работают без восклицательного знака (естественный ввод)_\n\n"
        "• `мут [срок] [причина]` — ограничить участника\n"
        "• `размут` — снять ограничения\n"
        "• `бан [причина]` — заблокировать в группе (Админ+)\n"
        "• `разбан [@user / ID]` — снять бан (Админ+)\n"
        "• `кик [причина]` — выгнать из группы\n"
        "• `варн [причина]` — выдать варн (3 варна = мут 24ч)\n"
        "• `анварн` — снять все варны\n"
        "• `дел` — удалить сообщение нарушителя (ответом)\n"
        "• `капча` — выдать проверку участнику\n"
        "• `состав` — список создателя, админов и модеров\n"
        "• `ранг` — мой ранг и разрешения в чате\n"
        "• `цель` / `буст` — цель и буст группы\n\n"
        "👉 Выберите категорию ниже для подробного описания:"
    )
    return send_group_msg(chat_id, text, thread_id=thread_id, reply_to=reply_to, keyboard=kb)


# ------------------------------ Обработка ------------------------------
def handle_callback(callback):
    """Нажатия на inline-кнопки."""
    data = callback.get("data", "")
    message = callback.get("message", {})
    chat_id = message.get("chat", {}).get("id")
    message_id = message.get("message_id")
    cb_sender = callback.get("from", {})
    user_id = str(cb_sender.get("id", ""))
    user_name = cb_sender.get("username")
    is_creator = is_creator_user(user_id, user_name)

    if data.startswith("c_ok:") or data.startswith("c_no:"):
        is_ok = data.startswith("c_ok:")
        parts = data.split(":")
        if len(parts) < 3:
            return
        target_chat = parts[1]
        target_user_id = parts[2]

        if str(user_id) != str(target_user_id) and not is_creator:
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

        success_text = (
            "✅ *Проверка успешно пройдена!*\n\n"
            "Ограничения в группе сняты — добро пожаловать в чат!"
        )
        plain_success = (
            "✅ Проверка успешно пройдена!\n\n"
            "Ограничения в группе сняты — добро пожаловать в чат!"
        )

        res_edit = api(
            "editMessageText",
            chat_id=chat_id,
            message_id=message_id,
            text=success_text,
            parse_mode="Markdown",
        )
        if not res_edit.get("ok") and "can't parse entities" in res_edit.get("description", "").lower():
            api(
                "editMessageText",
                chat_id=chat_id,
                message_id=message_id,
                text=plain_success,
            )
        return

    if data.startswith("verify_pass_"):
        handle_captcha_callback(callback)
        return

    # Навигация по правилам и командам (Iris Style) — доступна всем участникам
    if data.startswith("h_"):
        api("answerCallbackQuery", callback_query_id=callback.get("id"))
        back_kb = {
            "inline_keyboard": [
                [{"text": "◀ Назад к оглавлению", "callback_data": "h_main"}],
            ]
        }
        main_kb = {
            "inline_keyboard": [
                [
                    {"text": "🛡 Модерация", "callback_data": "h_mod"},
                    {"text": "👑 Ранги", "callback_data": "h_rank"},
                ],
                [
                    {"text": "⚙️ Настройки и Топики", "callback_data": "h_set"},
                    {"text": "🎯 Цели и Буст", "callback_data": "h_goal"},
                ],
            ]
        }
        if data == "h_main":
            text = (
                "📖 *Справочник команд (в стиле Iris CM)*\n\n"
                "💡 _Все команды работают без восклицательного знака (естественный ввод)_\n\n"
                "• `мут [срок] [причина]` — ограничить участника\n"
                "• `размут` — снять ограничения\n"
                "• `бан [причина]` — заблокировать в группе (Админ+)\n"
                "• `разбан [@user / ID]` — снять бан (Админ+)\n"
                "• `кик [причина]` — выгнать из группы\n"
                "• `варн [причина]` — выдать варн (3 варна = мут 24ч)\n"
                "• `анварн` — снять все варны\n"
                "• `дел` — удалить сообщение нарушителя (ответом)\n"
                "• `капча` — выдать проверку участнику\n"
                "• `состав` — список создателя, админов и модеров\n"
                "• `ранг` — мой ранг и разрешения в чате\n"
                "• `цель` / `буст` — прогресс цели и уровень буста группы\n\n"
                "👉 Выберите категорию ниже для подробного описания:"
            )
            api("editMessageText", chat_id=chat_id, message_id=message_id, text=text, reply_markup=main_kb, parse_mode="Markdown")
            return
        elif data == "h_mod":
            text = (
                "🛡 *Модерация чата (естественный синтаксис):*\n\n"
                "• `мут [время] [причина]` — ограничить нарушителя (ответом или @user). Время: `10м`, `2ч`, `1д`\n"
                "• `размут` — снять ограничения с участника\n"
                "• `бан [причина]` — блокировка навсегда (только ⭐️ Админ и 👑 Создатель)\n"
                "• `разбан [@user / ID]` — снять блокировку\n"
                "• `кик [причина]` — исключить из группы\n"
                "• `варн [причина]` — предупреждение (на 3 варне — мут на 24 часа)\n"
                "• `анварн` — аннулировать предупреждения\n"
                "• `дел` — удалить нежелательное сообщение (ответом)\n"
                "• `капча` — принудительно выдать проверку участнику"
            )
            api("editMessageText", chat_id=chat_id, message_id=message_id, text=text, reply_markup=back_kb, parse_mode="Markdown")
            return
        elif data == "h_rank":
            text = (
                "👑 *Иерархия и ранги участников:*\n\n"
                "• 👑 *Создатель (3)* — полный доступ ко всем функциям и настройкам.\n"
                "• ⭐️ *Админ (2)* — модерация, бан, назначение модераторов, цели и топики.\n"
                "• 🛡 *Модер (1)* — оперативная модерация: мут, кик, варн, дел, капча.\n"
                "• 👤 *Участник (0)* — просмотр правил, рангов, целей и статистики.\n\n"
                "⚙️ *Команды управления:* (без префиксов)\n"
                "• `админ @user` / `снять админ @user` — назначение администратора (Создатель)\n"
                "• `модер @user` / `снять модер @user` — назначение модератора (Админ+)\n"
                "• `снять @user` / `разжаловать @user` — разжалование\n"
                "• `состав` / `админы` — список администрации чата\n"
                "• `ранг` / `мой ранг` — проверить свои права и статус"
            )
            api("editMessageText", chat_id=chat_id, message_id=message_id, text=text, reply_markup=back_kb, parse_mode="Markdown")
            return
        elif data == "h_set":
            text = (
                "⚙️ *Настройки чата и Белый список:*\n\n"
                "• `топик` / `сеттопик` — закрепить тему для приветствий и проверок капчи\n"
                "• `-топик` / `сбростопик` — сбросить закрепление темы\n"
                "• `тест` / `статус` — диагностика бота и прав в ветке\n"
                "• `вайтлист` — список разрешённых чатов (в ЛС Создателя)\n"
                "• `+чат [ID] [Название]` — добавить чат в белый список (в ЛС или в чате)\n"
                "• `-чат [ID]` — удалить чат из белого списка"
            )
            api("editMessageText", chat_id=chat_id, message_id=message_id, text=text, reply_markup=back_kb, parse_mode="Markdown")
            return
        elif data == "h_goal":
            text = (
                "🎯 *Цели и Буст чата (/goal, /boost):*\n\n"
                "• `цель` — показать текущую цель сообщества и шкалу прогресса\n"
                "• `сетцель [число] [текст]` — назначить цель чата (Админ+)\n"
                "• `+прогресс [число]` — внести прогресс к цели\n"
                "• `сбросцель` — аннулировать цель чата\n\n"
                "• `буст` — карточка уровня прокачки группы и активные перки\n"
                "• `+буст [число]` — начислить очки буста сообщества (Админ+)"
            )
            api("editMessageText", chat_id=chat_id, message_id=message_id, text=text, reply_markup=back_kb, parse_mode="Markdown")
            return

    # Все остальные inline-действия (настройки, список, поиск, баны, вайтлист) — строго только для создателя
    if not is_creator:
        api("answerCallbackQuery", callback_query_id=callback.get("id"), text="⛔ Доступно только создателю.", show_alert=True)
        return

    if data.startswith("add_chat:"):
        cid = data.split(":", 1)[1]
        add_whitelisted_chat(cid, added_by=user_id)
        api("answerCallbackQuery", callback_query_id=callback.get("id"), text="✅ Чат добавлен в белый список!")
        api("editMessageText", chat_id=chat_id, message_id=message_id, text=f"✅ Чат `{cid}` успешно добавлен в белый список бота.")
        return

    if data.startswith("del_chat:"):
        cid = data.split(":", 1)[1]
        remove_whitelisted_chat(cid)
        api("answerCallbackQuery", callback_query_id=callback.get("id"), text="❌ Чат удалён из белого списка!")
        mod_data = load_mod_data()
        wl = mod_data.get("whitelisted_chats", {})
        unique_chats = {c_k: info for c_k, info in wl.items() if not str(c_k).startswith("@") and isinstance(info, dict) and "target_id" not in info}
        if not unique_chats:
            api("editMessageText", chat_id=chat_id, message_id=message_id, text="⚪ Белый список чатов пуст.")
        else:
            lines = ["⚪ *Белый список разрешённых чатов:*\n"]
            buttons = []
            for c_id, info in unique_chats.items():
                title = info.get("title", f"Чат {c_id}")
                lines.append(f"• *{title}* (ID: `{c_id}`)")
                buttons.append([{"text": f"❌ Удалить {title[:20]}", "callback_data": f"del_chat:{c_id}"}])
            lines.append("\n_Управление:_ `+чат ID [название]` или `-чат ID`")
            keyboard = {"inline_keyboard": buttons}
            api("editMessageText", chat_id=chat_id, message_id=message_id, text="\n".join(lines), reply_markup=keyboard, parse_mode="Markdown")
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

    my_chat_member = update.get("my_chat_member")
    if my_chat_member:
        handle_my_chat_member_update(my_chat_member)
        return

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
    text = (message.get("text") or message.get("caption") or "").strip()
    parts = text.split() if text else []
    if text:
        print(f"[MSG] chat={chat_id} ({chat_type}) from={user_id}: {text}")

    if user_id:
        disp_name = f"@{username}" if username else (sender.get("first_name") or f"ID:{user_id}")
        register_known_user(user_id, username, disp_name)

    reply_to = message.get("reply_to_message")
    if reply_to and not reply_to.get("forum_topic_created") and reply_to.get("from"):
        rf = reply_to["from"]
        rf_id = str(rf.get("id", ""))
        rf_uname = rf.get("username")
        rf_disp = f"@{rf_uname}" if rf_uname else (rf.get("first_name") or f"ID:{rf_id}")
        register_known_user(rf_id, rf_uname, rf_disp)

    # Регистрация упомянутых пользователей из entities (автокомплит ников в Telegram)
    for ent in list(message.get("entities", [])) + list(message.get("caption_entities", [])):
        if ent.get("type") == "text_mention" and ent.get("user"):
            tu = ent["user"]
            tu_id = str(tu.get("id", ""))
            tu_uname = tu.get("username")
            tu_disp = f"@{tu_uname}" if tu_uname else (tu.get("first_name") or f"ID:{tu_id}")
            register_known_user(tu_id, tu_uname, tu_disp)

    # ---------------- Групповые сообщения (Капча и Модерация) ----------------
    if chat_type in ("group", "supergroup"):
        reply_to = message.get("reply_to_message")
        if reply_to and reply_to.get("forum_topic_created"):
            reply_to = None

        first_w = text.split()[0].lower().lstrip("!/").split("@")[0] if text else ""

        # Проверка белого списка чатов: бот работает ТОЛЬКО в чатах из белого списка
        if not is_chat_whitelisted(chat_id):
            if is_creator_user(user_id, username):
                # Создатель использует команду в чате — мгновенно активируем чат и продолжаем работу
                add_whitelisted_chat(chat_id, chat.get("title"), user_id)
                if first_w in ("+чат", "добавитьчат", "вайтлист", "активировать", "addchat"):
                    send_group_msg(
                        chat_id,
                        f"✅ Чат *{chat.get('title', chat_id)}* успешно добавлен в белый список!\nБот активирован и готов к работе.",
                        thread_id=thread_id,
                        reply_to=message.get("message_id"),
                    )
                    return
                # Для любых других команд создателя чат уже автоматически добавлен выше,
                # поэтому выполнение не прерывается и продолжается дальше!
            else:
                # Чат не в белом списке и отправитель не создатель
                is_cmd_attempt = (
                    text.startswith(("/", "!"))
                    or first_w in (
                        "помощь", "правила", "help", "rules", "команды", "цель", "буст", "goal",
                        "boost", "ранг", "состав", "мут", "бан", "кик", "варн", "капча", "админ",
                        "модер", "снять", "инфо", "справка"
                    )
                )
                if is_cmd_attempt:
                    send_group_msg(
                        chat_id,
                        "⚠️ Бот в этой группе ещё не активирован создателем.\n"
                        "Для активации создатель бота должен написать любую команду в чате или добавить группу в белый список.",
                        thread_id=thread_id,
                        reply_to=message.get("message_id"),
                    )
                return

        # Удаление сервисного сообщения Telegram "Пользователь вошёл в группу" + вызов капчи
        new_members = message.get("new_chat_members") or ([message["new_chat_participant"]] if message.get("new_chat_participant") else None)
        if new_members:
            for nm in new_members:
                register_known_user(nm.get("id"), nm.get("username"), nm.get("first_name"))
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
            if is_creator_user(user_id, username) or get_user_chat_rank(chat_id, user_id) >= RANK_MODER:
                mod_data["pending_captcha"].pop(pending_key, None)
                save_mod_data(mod_data)
            else:
                try:
                    api("deleteMessage", chat_id=chat_id, message_id=message.get("message_id"))
                except Exception:
                    pass
                last_rem = mod_data["pending_captcha"][pending_key].get("last_remind", 0)
                if time.time() - last_rem > 15:
                    mod_data["pending_captcha"][pending_key]["last_remind"] = time.time()
                    save_mod_data(mod_data)
                    verify_url = f"https://t.me/{BOT_USERNAME}?start=verify_{chat_id}"
                    remind_kb = {"inline_keyboard": [[{"text": "🚪 Пройти капчу", "url": verify_url}]]}
                    send_group_msg(
                        chat_id,
                        f"⚠️ *{sender.get('first_name', 'Участник')}*, сообщения заблокированы до прохождения проверки!\nНажмите кнопку ниже:",
                        thread_id=thread_id,
                        keyboard=remind_kb,
                    )
                return

        if text:
            parts = text.split()
            bot_name = BOT_USERNAME.lower()
            bot_info = get_bot_info()
            if bot_info.get("username"):
                bot_name = bot_info["username"].lower()

            # Снимаем обращения к боту (@bot, @bot:, @bot,), просто "бот"/"bot", а также одиночные ! или /
            while parts:
                tok_clean = parts[0].lower().rstrip(":,!/")
                if tok_clean in (f"@{bot_name}", "@sporetdbot", "бот", "bot") or parts[0] in ("!", "/"):
                    parts = parts[1:]
                else:
                    break

            if not parts:
                return

            raw_token = parts[0].lower()
            first_token = raw_token.split("@")[0]
            clean_token = first_token.lstrip("!/").lower()
            user_rank = get_user_chat_rank(chat_id, user_id, username)
            is_creator = is_creator_user(user_id, username)

            # 1. Справка и правила бота (доступны всем участникам)
            if clean_token in ("помощь", "хелп", "help", "команды", "правила", "инфо", "rules", "правило", "справка"):
                render_help_message(chat_id, thread_id, message.get("message_id"))
                return

            # 2. Проверка статуса бота и прав в ветке (Админ+)
            if clean_token in ("тест", "чек", "test", "check", "статус"):
                if user_rank < RANK_ADMIN:
                    send_group_msg(chat_id, "⛔ Команда доступна от ранга ⭐️ Админ.", thread_id=thread_id, reply_to=message.get("message_id"))
                    return
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
                    f"👑 *Статус бота:* `{status}`\n"
                    f"🗑 Удаление сообщений: *{'✅' if can_del else '❌'}*\n"
                    f"🔇 Ограничение/мут: *{'✅' if can_restr else '❌'}*\n"
                    f"📂 Управление темами: *{'✅' if can_top else '❌'}*",
                    thread_id=thread_id,
                    reply_to=message.get("message_id"),
                )
                return

            # 3. Закрепление темы для приветствий новичков (Админ+)
            if clean_token in ("приветствие", "сетприветствие", "топик", "сеттопик", "settopic", "setwelcome"):
                if user_rank < RANK_ADMIN:
                    send_group_msg(chat_id, "⛔ Настраивать тему приветствий могут только ⭐️ Админы и 👑 Создатель.", thread_id=thread_id, reply_to=message.get("message_id"))
                    return
                mod_data = load_mod_data()
                if "chat_topics" not in mod_data:
                    mod_data["chat_topics"] = {}
                mod_data["chat_topics"][str(chat_id)] = thread_id
                save_mod_data(mod_data)
                send_group_msg(
                    chat_id,
                    f"✅ Тема закреплена для приветствий и капчи!\n🧵 *ID темы:* `{thread_id or 'General'}`\nБот будет писать приветствия только сюда.",
                    thread_id=thread_id,
                    reply_to=message.get("message_id"),
                )
                return

            # 4. Отмена закрепления темы приветствий (Админ+)
            if clean_token in ("-приветствие", "-топик", "сбростопик", "сбросприветствие", "unsettopic", "unsetwelcome"):
                if user_rank < RANK_ADMIN:
                    send_group_msg(chat_id, "⛔ Сбрасывать тему приветствий могут только ⭐️ Админы и 👑 Создатель.", thread_id=thread_id, reply_to=message.get("message_id"))
                    return
                mod_data = load_mod_data()
                mod_data.get("chat_topics", {}).pop(str(chat_id), None)
                save_mod_data(mod_data)
                send_group_msg(
                    chat_id,
                    "✅ Закрепление темы для приветствий снято.\nПриветствия будут приходить в общий чат (General).",
                    thread_id=thread_id,
                    reply_to=message.get("message_id"),
                )
                return

            # 5. Ручной вызов капчи участнику или тестовая капча (Модер+)
            if clean_token in ("капча", "проверка", "captcha", "testcaptcha", "тесткапча"):
                if user_rank < RANK_MODER:
                    send_group_msg(chat_id, "⛔ Вызов проверки доступен от ранга 🛡 Модер.", thread_id=thread_id, reply_to=message.get("message_id"))
                    return
                if reply_to:
                    target_u = reply_to.get("from", {})
                    t_uid = target_u.get("id")
                    if is_creator_user(t_uid, target_u.get("username")):
                        send_group_msg(chat_id, "⚠️ Нельзя вызвать проверку для создателя.", thread_id=thread_id, reply_to=message.get("message_id"))
                        return
                    handle_new_chat_members(chat_id, [target_u], reply_to.get("message_id"), thread_id)
                else:
                    try:
                        api("deleteMessage", chat_id=chat_id, message_id=message.get("message_id"))
                    except Exception:
                        pass
                    captcha_text, captcha_kb, _ = generate_symbol_captcha("test", user_id)
                    send_message(user_id, f"🧪 *Тестовая проверка:*\n\n{captcha_text}", keyboard=captcha_kb)
                return

            # 6. Управление белым списком чатов из группы (Создатель)
            if clean_token in ("+чат", "добавитьчат", "вайтлист", "активировать", "addchat"):
                if is_creator:
                    add_whitelisted_chat(chat_id, chat.get("title"), user_id)
                    send_group_msg(chat_id, f"✅ Чат *{chat.get('title', chat_id)}* добавлен в белый список бота!", thread_id=thread_id, reply_to=message.get("message_id"))
                    return
            if clean_token in ("-чат", "удалитьчат", "delchat"):
                if is_creator:
                    remove_whitelisted_chat(chat_id)
                    send_group_msg(chat_id, "❌ Чат удалён из белого списка бота.", thread_id=thread_id, reply_to=message.get("message_id"))
                    return

            # 7. Система рангов ('создатель, админ, модер')
            # 7.1 Снятие варнов через "снять варн" / "снять варны"
            if clean_token in ("снять", "разжаловать") and len(parts) > 1 and parts[1].lower().rstrip("!/") in ("варн", "варны", "предупреждение", "предупреждения"):
                handle_moderation_command(message, "unwarn", parts[2:])
                return

            # 7.2 Проверка своего ранга или состава администрации
            clean_phrase_clean = " ".join(parts).lower().lstrip("!/").rstrip("?")
            if clean_phrase_clean in ("мой ранг", "мойранг", "кто я", "ктоя", "whoami", "my rank") or clean_token in ("ранг", "мойранг", "ктоя", "whoami", "rank"):
                handle_role_command(message, "my_rank", [])
                return
            if clean_phrase_clean in ("состав", "админы", "модеры", "персонал", "команда", "ранги", "список админов", "список администрации", "администрация", "staff", "admins", "moders") or clean_token in ("состав", "админы", "модеры", "персонал", "команда", "ранги", "staff", "admins", "moders"):
                handle_role_command(message, "staff", [])
                return

            # 7.3 Команды назначения и разжалования ролей
            is_role_cmd = False
            role_subcmd = None
            role_args = parts[1:]

            if clean_token in ("снять", "разжаловать") and len(parts) > 1 and parts[1].lower().rstrip("!/") in ("админ", "админа", "admin", "админку", "администратора"):
                is_role_cmd = True
                role_subcmd = "unset_admin"
                role_args = parts[2:]
            elif clean_token in ("снять", "разжаловать") and len(parts) > 1 and parts[1].lower().rstrip("!/") in ("модер", "модера", "moder", "модерку", "модератора"):
                is_role_cmd = True
                role_subcmd = "unset_moder"
                role_args = parts[2:]
            elif clean_token in ("назначить", "сделать", "дать") and len(parts) > 1 and parts[1].lower().rstrip("!/") in ("админ", "админа", "админом", "admin", "админку", "администратора"):
                is_role_cmd = True
                role_subcmd = "set_admin"
                role_args = parts[2:]
            elif clean_token in ("назначить", "сделать", "дать") and len(parts) > 1 and parts[1].lower().rstrip("!/") in ("модер", "модера", "модером", "moder", "модерку", "модератора"):
                is_role_cmd = True
                role_subcmd = "set_moder"
                role_args = parts[2:]
            elif clean_token in ("-админ", "-admin", "снятьадмин", "снятьадмина", "снятьadmin", "снятьадминку", "разжаловатьадмина"):
                is_role_cmd = True
                role_subcmd = "unset_admin"
                role_args = parts[1:]
            elif clean_token in ("-модер", "-moder", "снятьмодер", "снятьмодера", "снятьmoder", "снятьмодерку", "разжаловатьмодера"):
                is_role_cmd = True
                role_subcmd = "unset_moder"
                role_args = parts[1:]
            elif clean_token in ("+админ", "+admin", "админ", "admin", "администратор", "админка", "сделатьадмином", "назначитьадмина", "датьадминку"):
                is_role_cmd = True
                role_subcmd = "set_admin"
                role_args = parts[1:]
            elif clean_token in ("+модер", "+moder", "модер", "moder", "модератор", "модерка", "сделатьмодером", "назначитьмодера", "датьмодерку"):
                is_role_cmd = True
                role_subcmd = "set_moder"
                role_args = parts[1:]
            elif clean_token in ("снять", "разжаловать", "demote"):
                is_role_cmd = True
                role_subcmd = "demote"
                role_args = parts[1:]

            if is_role_cmd:
                handle_role_command(message, role_subcmd, role_args)
                return

            # 8. Цели сообщества (/goal)
            if clean_token in ("цель", "сетцель", "прогресс", "+прогресс", "сбросцель", "goal") or (clean_token in ("сброс", "reset") and len(parts) > 1 and parts[1].lower().rstrip("!/") in ("цель", "goal")):
                sub = "reset_goal" if clean_token in ("сброс", "reset") else clean_token
                g_args = parts[2:] if clean_token in ("сброс", "reset") else parts[1:]
                handle_goal_command(message, sub, g_args)
                return

            # 9. Буст сообщества (/boost)
            if clean_token in ("буст", "+буст", "boost", "сбросбуст") or (clean_token in ("сброс", "reset") and len(parts) > 1 and parts[1].lower().rstrip("!/") in ("буст", "boost")):
                sub = "reset_boost" if clean_token in ("сброс", "reset") else clean_token
                b_args = parts[2:] if clean_token in ("сброс", "reset") else parts[1:]
                handle_boost_command(message, sub, b_args)
                return

            # 10. Реферальная программа (/ref, реферал)
            if clean_token in ("реферал", "рефералка", "рефералы", "рефы", "ref", "referral"):
                handle_referral_command(message)
                return

            # 11. Модерация чата (мут, размут, бан, разбан, кик, варн, анварн, варны, дел)
            cmd = MOD_MAP.get(first_token) or MOD_MAP.get(clean_token)
            if cmd:
                # Определяем, что это команда модерации, а не случайное слово в диалоге
                is_explicit_cmd = (
                    first_token.startswith(("/", "!"))
                    or (reply_to is not None)
                    or (cmd == "warns")
                    or (len(parts) > 1 and (parts[1].startswith("@") or parts[1].isdigit() or parse_time_str(parts[1]) is not None))
                    or (user_rank >= RANK_MODER)
                )
                if is_explicit_cmd:
                    handle_moderation_command(message, cmd, parts[1:])
                    return

        return

    # ---------------- Личные сообщения ----------------
    is_creator = is_creator_user(user_id, username)

    # 1. Сначала гарантированно создаём/обновляем профиль пользователя
    ensure_user(user_id, user_nick(message), username)

    # 2. Определяем роль пользователя и клавиатуру
    role = "player"
    if db is not None:
        try:
            snapshot = db.collection("users").document(str(user_id)).get()
            if snapshot.exists:
                role = snapshot.to_dict().get("role", "player")
        except Exception:
            pass
    if is_creator:
        role = "creator"

    # Клавиатура внизу (тестерам/создателю — с кнопкой тестовой версии)
    CURRENT_KEYBOARD = menu_keyboard(role)

    # 3. Забаненным (кроме создателя) доступ к боту закрыт
    if not is_creator:
        banned = bool(get_user_data(user_id).get("banned")) or is_username_banned(username) or (str(user_id) in load_banned_ids())
        if banned:
            if username:
                set_ban(user_id, True)
            send_message(chat_id, "🚫 Доступ к боту закрыт.", markdown=False)
            return

    start_verify_match = re.match(r"^/start\s+verify_([-\w]+)", text)
    if start_verify_match:
        target_chat = start_verify_match.group(1).strip()
        captcha_text, captcha_kb, _ = generate_symbol_captcha(target_chat, user_id)
        send_message(
            chat_id,
            captcha_text,
            keyboard=captcha_kb,
        )
        return

    start_ref_match = re.match(r"^/start\s+ref_([-\w]+)", text)
    if start_ref_match:
        welcome_text = (
            "👋 *Добро пожаловать в Spore Tower Defense!*\n\n"
            "ℹ️ _Реферальная система временно отключена на время балансировки экономики и золота._\n\n"
            "🏰 Строй башни и не пусти заражённых до конца дороги!\n\n"
            "🎮 Нажми *«Играть»* слева внизу, чтобы начать бой."
        )
        send_message(chat_id, welcome_text)
        return

    # Управление белым списком разрешённых чатов (только создатель в ЛС)
    if is_creator and text:
        norm_text = text.lower().strip()
        clean_pm_cmd = text.split()[0].lower().lstrip("!/")

        # Просмотр белого списка чатов
        if norm_text in (
            "whitelist", "вайтлист", "белый список", "белыйсписок", "chats", "чаты", "список чатов",
            "/whitelist", "/chats"
        ) or (clean_pm_cmd in ("whitelist", "вайтлист", "чаты", "chats") and len(parts) == 1):
            mod_data = load_mod_data()
            wl = mod_data.get("whitelisted_chats", {})
            unique_chats = {cid: info for cid, info in wl.items() if not str(cid).startswith("@")}
            if not unique_chats:
                send_message(
                    chat_id,
                    "⚪ *Белый список разрешённых чатов пуст.*\n\n"
                    "Чтобы активировать работу бота в группе, отправьте:\n"
                    "`+чат ID_ЧАТА [Название]`\n\n"
                    "_Или просто перешлите сюда любое сообщение из нужной группы!_",
                )
            else:
                lines = ["⚪ *Белый список разрешённых чатов:*\n"]
                buttons = []
                for cid, info in unique_chats.items():
                    title = info.get("title", f"Чат {cid}")
                    lines.append(f"• *{title}* (ID: `{cid}`)")
                    buttons.append([{"text": f"❌ Удалить {title[:20]}", "callback_data": f"del_chat:{cid}"}])
                lines.append("\n_Управление:_ `+чат ID [название]` или `-чат ID`")
                keyboard = {"inline_keyboard": buttons}
                send_message(chat_id, "\n".join(lines), keyboard=keyboard)
            return

        # Добавление чата: +чат, + чат, добавить чат, /addchat, вайтлист +
        is_add_chat = False
        add_args = []
        if clean_pm_cmd in ("+чат", "добавитьчат", "addchat"):
            is_add_chat = True
            add_args = parts[1:]
        elif len(parts) >= 2 and parts[0] in ("+", "добавить", "разрешить") and parts[1].lower() in ("чат", "группу"):
            is_add_chat = True
            add_args = parts[2:]
        elif len(parts) >= 3 and clean_pm_cmd in ("вайтлист", "белыйсписок", "whitelist") and parts[1] == "+":
            is_add_chat = True
            add_args = parts[2:]

        if is_add_chat:
            if not add_args:
                send_message(chat_id, "ℹ️ Использование: `+чат ID_ЧАТА [Название]`\nПример: `+чат -1003979980916 Основной чат`\n_Также можно указать @username публичной группы._")
                return
            target_chat_id = add_args[0].strip()
            title = " ".join(add_args[1:]).strip() if len(add_args) > 1 else None
            real_id, real_title = add_whitelisted_chat(target_chat_id, title=title, added_by=user_id)
            send_message(chat_id, f"✅ Чат *{real_title}* (ID: `{real_id}`) успешно добавлен в белый список!\nБот готов работать в этой группе.")
            return

        # Удаление чата: -чат, - чат, удалить чат, /delchat, вайтлист -
        is_del_chat = False
        del_args = []
        if clean_pm_cmd in ("-чат", "удалитьчат", "delchat"):
            is_del_chat = True
            del_args = parts[1:]
        elif len(parts) >= 2 and parts[0] in ("-", "удалить", "запретить") and parts[1].lower() in ("чат", "группу"):
            is_del_chat = True
            del_args = parts[2:]
        elif len(parts) >= 3 and clean_pm_cmd in ("вайтлист", "белыйсписок", "whitelist") and parts[1] == "-":
            is_del_chat = True
            del_args = parts[2:]

        if is_del_chat:
            if not del_args:
                send_message(chat_id, "ℹ️ Использование: `-чат ID_ЧАТА`")
                return
            target_chat_id = del_args[0].strip()
            if remove_whitelisted_chat(target_chat_id):
                send_message(chat_id, f"✅ Чат `{target_chat_id}` удалён из белого списка.")
            else:
                send_message(chat_id, f"⚠️ Чат `{target_chat_id}` не найден в белом списке.")
            return

    # Пересылка сообщения из группы / канала создателем в ЛС бота:
    if is_creator:
        origin = message.get("forward_origin") or {}
        fwd_chat = message.get("forward_from_chat") or origin.get("chat")
        if fwd_chat and fwd_chat.get("id"):
            fc_id = fwd_chat["id"]
            fc_title = fwd_chat.get("title") or fwd_chat.get("username") or str(fc_id)
            send_message(
                chat_id,
                f"📍 *Обнаружен пересланный чат:*\n"
                f"• Название: *{fc_title}*\n"
                f"• ID: `{fc_id}`\n\n"
                f"➕ Добавить этот чат в белый список?",
                keyboard={
                    "inline_keyboard": [
                        [{"text": f"➕ Добавить {fc_title[:20]} в вайтлист", "callback_data": f"add_chat:{fc_id}"}],
                    ]
                },
            )
            return

    # Информационные команды в ЛС бота (справка и правила без !)
    clean_pm_cmd = text.split()[0].lower().lstrip("!/").split("@")[0] if text else ""
    if clean_pm_cmd in ("помощь", "хелп", "help", "команды", "правила", "инфо", "rules", "правило", "справка"):
        render_help_message(chat_id)
        return

    if clean_pm_cmd in ("goal", "цель", "boost", "буст"):
        send_message(
            chat_id,
            "🎯 *Команды целей и бустов работают в группах и супергруппах.*\n\n"
            "Добавьте бота в чат сообщества и используйте команду `/goal` или `/boost` непосредственно в группе!",
        )
        return

    pm_parts = text.split() if text else []
    if clean_pm_cmd in ("ранг", "мойранг", "rank") or (len(pm_parts) > 1 and pm_parts[0].lower().lstrip("!/") in ("мой", "my") and pm_parts[1].lower().startswith("ранг")):
        user_role_label = ROLE_LABELS.get(role, role)
        send_message(
            chat_id,
            f"👤 *Ваш профиль в боте:*\n"
            f"• ID: `{user_id}`\n"
            f"• Глобальная роль: *{user_role_label}*\n\n"
            f"💡 _Ранги модерации (`создатель`, `админ`, `модер`) действуют внутри групп Telegram из белого списка._",
        )
        return

    if clean_pm_cmd in ("состав", "админы", "модеры", "staff", "admins", "moders"):
        send_message(
            chat_id,
            "👥 *Состав администрации:*\n"
            "Список создателей, администраторов и модераторов формируется отдельно для каждой группы Telegram.\n"
            "Используйте команду `состав` непосредственно в чате группы!",
        )
        return

    if clean_pm_cmd in ("админ", "модер", "admin", "moder", "снять", "разжаловать", "повысить", "понизить"):
        send_message(
            chat_id,
            "👑 *Управление администрацией:*\n"
            "Назначение и разжалование участников (`админ @user`, `модер @user`, `снять @user`) выполняется внутри групп Telegram.",
        )
        return

    if clean_pm_cmd in ("мут", "бан", "кик", "варн", "анварн", "варны", "дел", "размут", "разбан"):
        send_message(
            chat_id,
            "🛡 *Модерация:*\n"
            "Команды управления участниками (`мут`, `кик`, `бан`, `варн`, `дел`) применяются внутри групп Telegram.",
        )
        return

    if text in ("/testcaptcha", "/captcha", "!капча", "!тесткапча", "капча"):
        captcha_text, captcha_kb, _ = generate_symbol_captcha("test", user_id)
        send_message(
            chat_id,
            captcha_text,
            keyboard=captcha_kb,
        )
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
    elif text in ("/ref", "/referral") or (text and text.lower().strip() in ("реферал", "рефералка", "рефералы", "рефы")):
        handle_referral_command(message)
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
                allowed_updates=["message", "edited_message", "callback_query", "chat_member", "my_chat_member"],
            )
            if not res.get("ok"):
                time.sleep(2)
                continue
            updates = res.get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                try:
                    handle_update(update)
                except Exception as err:
                    import traceback
                    print(f"[ERROR] handle_update exception for update_id={update.get('update_id')}: {err}")
                    traceback.print_exc()
        except KeyboardInterrupt:
            print("Остановлено.")
            break
        except Exception as error:
            print("Ошибка в основном цикле, повтор через 3 сек:", error)
            time.sleep(3)


if __name__ == "__main__":
    main()
