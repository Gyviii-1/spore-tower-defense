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
import re
import time

import requests

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
def api(method, **params):
    """Вызов метода Telegram Bot API."""
    response = requests.post(f"{API}/{method}", json=params, timeout=40)
    return response.json()


def send_message(chat_id, text, markdown=True, keyboard=None):
    payload = {
        "chat_id": chat_id,
        "text": text,
        "reply_markup": keyboard if keyboard is not None else CURRENT_KEYBOARD,
    }
    if markdown:
        payload["parse_mode"] = "Markdown"
    api("sendMessage", **payload)


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


def load_mod_data():
    """Загружает данные модерации (варны и ожидающие капчи)."""
    if os.path.exists(MODERATION_FILE):
        try:
            with open(MODERATION_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"warns": {}, "pending_captcha": {}}


def save_mod_data(data):
    """Сохраняет данные модерации."""
    try:
        with open(MODERATION_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as error:
        print("[ERROR] save_mod_data:", error)


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


def is_chat_admin(chat_id, user_id):
    """Проверяет, является ли пользователь администратором группы."""
    if str(user_id) == str(CREATOR_ID):
        return True
    try:
        res = api("getChatMember", chat_id=chat_id, user_id=user_id)
        if res.get("ok"):
            status = res["result"].get("status")
            return status in ("creator", "administrator")
    except Exception as e:
        print(f"[WARN] is_chat_admin error: {e}")
    return False


def handle_new_chat_members(chat_id, new_members, message_id=None, message_thread_id=None):
    """Ограничивает нового участника и отправляет капчу с кнопкой в личку."""
    mod_data = load_mod_data()

    if message_thread_id:
        if "chat_topics" not in mod_data:
            mod_data["chat_topics"] = {}
        mod_data["chat_topics"][str(chat_id)] = message_thread_id
    elif str(chat_id) in mod_data.get("chat_topics", {}):
        message_thread_id = mod_data["chat_topics"][str(chat_id)]

    for member in new_members:
        if member.get("is_bot"):
            continue
        uid = member["id"]
        first_name = member.get("first_name") or "Новичок"

        print(f"[CAPTCHA] Restricting new member {uid} ({first_name}) in chat {chat_id}, thread: {message_thread_id}")
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
                [{"text": "🤖 Пройти капчу в боте", "url": verify_url}]
            ]
        }
        text = (
            f"👋 [{first_name}](tg://user?id={uid}), добро пожаловать в группу!\n\n"
            f"🛡 *Чтобы писать в чате, подтверди, что ты человек.*\n"
            f"Нажми на кнопку ниже:"
        )

        res = send_group_msg(chat_id, text, thread_id=message_thread_id, reply_markup=keyboard)
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

    print(f"[CHAT_MEMBER] Chat {chat_id}: user {new_user.get('id')} ({new_user.get('first_name')}) status {old_status} -> {new_status}")
    if old_status in ("left", "kicked", None) and new_status in ("member", "restricted"):
        handle_new_chat_members(chat_id, [new_user], message_id=None, message_thread_id=None)


def handle_captcha_callback(callback):
    """Снимает ограничения после нажатия кнопки капчи в личке."""
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
    payload.update(kwargs)
    res = api("sendMessage", **payload)
    if not res.get("ok") and thread_id:
        del payload["message_thread_id"]
        res = api("sendMessage", **payload)
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

    if not is_chat_admin(chat_id, sender_id):
        msg_reply("⚠️ Эта команда доступна только администраторам группы.")
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

    if data.startswith("verify_pass_"):
        handle_captcha_callback(callback)
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

    # Остальные inline-кнопки (список, поиск, баны) — только для создателя.
    if not is_creator:
        api("answerCallbackQuery", callback_query_id=callback.get("id"), text="Только для создателя")
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

    # ---------------- Групповые сообщения (Капча и Модерация) ----------------
    if chat_type in ("group", "supergroup"):
        reply_to = message.get("reply_to_message")

        # Сохраняем ID топика чата для последующих приветствий
        if thread_id:
            mod_data = load_mod_data()
            if mod_data.get("chat_topics", {}).get(str(chat_id)) != thread_id:
                if "chat_topics" not in mod_data:
                    mod_data["chat_topics"] = {}
                mod_data["chat_topics"][str(chat_id)] = thread_id
                save_mod_data(mod_data)

        # Удаление сервисного сообщения Telegram "Пользователь вошёл в группу" + вызов капчи
        new_members = message.get("new_chat_members")
        if new_members:
            try:
                api("deleteMessage", chat_id=chat_id, message_id=message.get("message_id"))
            except Exception as e:
                print(f"[WARN] Failed to delete system join msg: {e}")
            handle_new_chat_members(chat_id, new_members, message.get("message_id"), thread_id)
            return

        # Удаление сервисного сообщения Telegram "Пользователь покинул группу"
        if message.get("left_chat_member"):
            try:
                api("deleteMessage", chat_id=chat_id, message_id=message.get("message_id"))
            except Exception:
                pass
            return

        if text:
            parts = text.split()
            first_token = parts[0].lower().split("@")[0]

            # Команда проверки статуса бота в этом топике
            if first_token in ("!тест", "!чек", "/test", "/check"):
                bot_me = api("getMe").get("result", {})
                bot_perms = api("getChatMember", chat_id=chat_id, user_id=bot_me.get("id")).get("result", {})
                can_del = bot_perms.get("can_delete_messages", False)
                can_restr = bot_perms.get("can_restrict_members", False)
                can_top = bot_perms.get("can_manage_topics", False)
                status = bot_perms.get("status", "unknown")
                send_group_msg(
                    chat_id,
                    f"🤖 *SporeTD Bot активен в этой ветке!*\n\n"
                    f"📍 *ID чата:* `{chat_id}`\n"
                    f"🧵 *Топик:* `{thread_id or 'General'}`\n"
                    f"👑 *Статус:* `{status}`\n"
                    f"🗑 Удаление сообщений: *{'✅' if can_del else '❌'}*\n"
                    f"🔇 Ограничение/мут: *{'✅' if can_restr else '❌'}*\n"
                    f"📂 Управление темами: *{'✅' if can_top else '❌'}*",
                    thread_id=thread_id,
                    reply_to=message.get("message_id"),
                )
                return

            # Команда ручного вызова капчи на пользователя: !капча ответом
            if first_token in ("!капча", "!проверка", "/captcha"):
                if reply_to:
                    target_u = reply_to.get("from", {})
                    handle_new_chat_members(chat_id, [target_u], reply_to.get("message_id"), thread_id)
                else:
                    send_group_msg(chat_id, "ℹ️ Ответьте на сообщение участника командой `!капча`, чтобы вызвать для него проверку.", thread_id=thread_id, reply_to=message.get("message_id"))
                return

            cmd = MOD_MAP.get(first_token)
            if cmd:
                handle_moderation_command(message, cmd, parts[1:])
                return
            if first_token in ("/help", "!help", "!хелп", "!помощь"):
                help_text = (
                    "🛡 *Команды модератора (ответом на сообщение нарушителя):*\n\n"
                    "• `!мут [время] [причина]` — замутить нарушителя\n"
                    "• `!размут` — снять мут\n"
                    "• `!бан [причина]` — заблокировать в группе\n"
                    "• `!разбан [@user / ID]` — разблокировать\n"
                    "• `!кик` — исключить из группы\n"
                    "• `!варн [причина]` — предупреждение (3 варна = мут на 24ч)\n"
                    "• `!анварн` — снять все предупреждения\n"
                    "• `!дел` — удалить сообщение\n"
                    "• `!капча` — принудительно выдать проверку участнику\n"
                    "• `!тест` — проверить статус бота и права в топике\n\n"
                    "⏱ *Время:* `10м`, `2ч`, `1д` (если не указано — 1 час)."
                )
                send_group_msg(chat_id, help_text, thread_id=thread_id, reply_to=message.get("message_id"))
                return

        return

    # ---------------- Личные сообщения ----------------
    if text.startswith("/start verify_"):
        target_chat = text.replace("/start verify_", "").strip()
        keyboard = {
            "inline_keyboard": [
                [{"text": "✅ Я человек (Разблокировать чат)", "callback_data": f"verify_pass_{target_chat}"}]
            ]
        }
        send_message(
            chat_id,
            "🛡 *Проверка безопасности для входа в группу*\n\n"
            "Нажми кнопку ниже, чтобы подтвердить, что ты не робот, и получить доступ к отправке сообщений в чате:",
            keyboard=keyboard,
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
            updates = api(
                "getUpdates",
                offset=offset,
                timeout=30,
                allowed_updates=["message", "edited_message", "callback_query", "chat_member"],
            ).get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                handle_update(update)
        except KeyboardInterrupt:
            print("Остановлено.")
            break
        except Exception as error:
            print("Ошибка сети, повтор через 3 сек:", error)
            time.sleep(3)


if __name__ == "__main__":
    main()
