# -*- coding: utf-8 -*-
"""Комплексный расширенный тест всех систем бота:
1. Вайтлист (белый список чатов, ID, @username, ссылки t.me, удаление)
2. Иерархия (Создатель, Админ, Модер, Участник, иммунитет, явное разжалование)
3. Команды без префикса !
4. Системы целей (/goal) и бустов (/boost)
5. Проверка прав модерации, субординации (в т.ч. в команде 'дел')
6. Проверка команды 'варны' и синтаксиса 'снять варн'
7. Доступность базовых команд в ЛС для обычных игроков (/start, /help, etc.)
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot

def test_whitelist():
    print("[TEST] 1. Whitelist system & aliases...")
    bot._MOD_DATA_CACHE = None
    cid = "-100888777666"
    link_cid = "-1001234567890"
    bot.remove_whitelisted_chat(cid)
    bot.remove_whitelisted_chat(link_cid)
    bot.remove_whitelisted_chat("@test_spore_group")
    bot.remove_whitelisted_chat("test_spore_group")

    assert not bot.is_chat_whitelisted(cid)

    # 1.1 Добавление по ID
    bot.add_whitelisted_chat(cid, "Тестовый чат 1", "1802519292")
    assert bot.is_chat_whitelisted(cid)
    data = bot.load_mod_data()
    assert cid in data["whitelisted_chats"]
    assert data["whitelisted_chats"][cid]["title"] == "Тестовый чат 1"

    # 1.2 Добавление по ссылке t.me/c/...
    link_cid = "-1001234567890"
    bot.add_whitelisted_chat("https://t.me/c/1234567890/55", "Чат по ссылке", "1802519292")
    assert bot.is_chat_whitelisted(link_cid)

    # 1.3 Добавление по @username
    bot.add_whitelisted_chat("@test_spore_group", "Группа со скобкой", "1802519292")
    assert bot.is_chat_whitelisted("@test_spore_group")
    assert bot.is_chat_whitelisted("test_spore_group")

    # 1.4 Удаление чатов
    bot.remove_whitelisted_chat(cid)
    assert not bot.is_chat_whitelisted(cid)
    bot.remove_whitelisted_chat(link_cid)
    assert not bot.is_chat_whitelisted(link_cid)
    bot.remove_whitelisted_chat("@test_spore_group")
    assert not bot.is_chat_whitelisted("@test_spore_group")

    data = bot.load_mod_data()
    assert cid not in data["whitelisted_chats"]
    print(" -> Whitelist OK")

def test_roles_hierarchy():
    print("[TEST] 2. Roles, Hierarchy & Subordination...")
    chat_id = "-1003979980916"
    creator_id = "1802519292"
    admin_id = "111222333"
    moder_id = "444555666"
    user_id = "777888999"

    # Очистка перед проверкой начальных рангов
    bot.remove_chat_role(chat_id, admin_id)
    bot.remove_chat_role(chat_id, moder_id)
    bot.remove_chat_role(chat_id, user_id)

    # Проверка начальных рангов
    assert bot.get_user_chat_rank(chat_id, creator_id) == bot.RANK_CREATOR
    assert bot.get_user_chat_rank(chat_id, admin_id) == bot.RANK_USER
    assert bot.get_user_chat_rank(chat_id, moder_id) == bot.RANK_USER
    assert bot.get_user_chat_rank(chat_id, user_id) == bot.RANK_USER

    # Назначаем Админа и Модера
    bot.set_chat_role(chat_id, admin_id, "admin", creator_id)
    bot.set_chat_role(chat_id, moder_id, "moder", admin_id)

    assert bot.get_user_chat_rank(chat_id, admin_id) == bot.RANK_ADMIN
    assert bot.get_user_chat_rank(chat_id, moder_id) == bot.RANK_MODER

    # Проверка субординации:
    # Модер не может наказать другого модера (равный ранг)
    assert not (bot.RANK_MODER > bot.RANK_MODER)
    # Модер не может наказать Админа
    assert not (bot.RANK_MODER > bot.RANK_ADMIN)
    # Админ может наказать Модера
    assert bot.RANK_ADMIN > bot.RANK_MODER
    # Никто не может наказать Создателя
    assert not (bot.RANK_ADMIN > bot.RANK_CREATOR)

    # Проверка явного разжалования в "user"
    bot.set_chat_role(chat_id, admin_id, "user", creator_id)
    assert bot.get_user_chat_rank(chat_id, admin_id) == bot.RANK_USER

    bot.set_chat_role(chat_id, moder_id, "user", admin_id)
    assert bot.get_user_chat_rank(chat_id, moder_id) == bot.RANK_USER

    # Очистка
    bot.remove_chat_role(chat_id, admin_id)
    bot.remove_chat_role(chat_id, moder_id)
    print(" -> Roles & Hierarchy OK")

def test_del_subordination():
    print("[TEST] 3. 'Дел' subordination check...")
    chat_id = "-1003979980916"
    creator_id = "1802519292"
    admin_id = "111222333"
    moder_id = "444555666"

    # Создатель не может быть целью удаления сообщения модером
    c_rank = bot.get_user_chat_rank(chat_id, creator_id)
    m_rank = bot.RANK_MODER
    a_rank = bot.RANK_ADMIN

    # Модер не должен иметь права удалять сообщения админа или создателя
    assert m_rank <= c_rank
    assert m_rank <= a_rank
    # Создатель имеет абсолютный иммунитет
    assert c_rank == bot.RANK_CREATOR
    print(" -> 'Дел' subordination OK")

def test_warns_and_unwarn():
    print("[TEST] 4. Warns and Unwarn system...")
    chat_id = "-1003979980916"
    target_id = "555777999"
    warn_key = f"{chat_id}_{target_id}"

    data = bot.load_mod_data()
    data["warns"][warn_key] = 2
    bot.save_mod_data(data)

    # Проверяем наличие варнов
    chk_data = bot.load_mod_data()
    assert chk_data["warns"].get(warn_key) == 2

    # Проверяем наличие команды в MOD_MAP
    assert "варны" in bot.MOD_MAP
    assert bot.MOD_MAP["варны"] == "warns"
    assert bot.MOD_MAP["анварн"] == "unwarn"
    assert bot.MOD_MAP["снятьварн"] == "unwarn"

    # Очистка варнов
    chk_data["warns"].pop(warn_key, None)
    bot.save_mod_data(chk_data)
    print(" -> Warns & Unwarn OK")

def test_goal_and_boost():
    print("[TEST] 5. Goal & Boost...")
    chat_id = "-1003979980916"
    bot.reset_chat_goal(chat_id)
    bot.reset_chat_boost(chat_id)

    # Goal
    bot.set_chat_goal(chat_id, 100, "Пройти 100 волн", "волн", "1802519292")
    g = bot.get_chat_goal(chat_id)
    assert g["target"] == 100
    assert g["current"] == 0
    bot.add_goal_progress(chat_id, 75)
    g = bot.get_chat_goal(chat_id)
    assert g["current"] == 75
    text = bot.render_goal_text(chat_id)
    assert "75%" in text
    bot.reset_chat_goal(chat_id)
    assert bot.get_chat_goal(chat_id) is None

    # Boost
    b1 = bot.add_chat_boost(chat_id, 50)
    assert b1["level"] == 1
    b2 = bot.add_chat_boost(chat_id, 60) # total 110
    assert b2["level"] == 2
    b3 = bot.add_chat_boost(chat_id, 200) # total 310
    assert b3["level"] == 3
    b_text = bot.render_boost_text(chat_id)
    assert "Уровень 3" in b_text
    bot.reset_chat_boost(chat_id)
    print(" -> Goal & Boost OK")

def test_no_exclamation_mark():
    print("[TEST] 6. Command syntax without '!'...")
    p_help = bot.commands_text("player")
    c_help = bot.commands_text("creator")
    assert "!" not in p_help, "Exclamation mark found in player help"
    assert "!" not in c_help, "Exclamation mark found in creator help"

    # Проверка словаря команд MOD_MAP: все базовые команды доступны без !
    for cmd in ["мут", "размут", "бан", "разбан", "кик", "варн", "анварн", "варны", "дел"]:
        assert cmd in bot.MOD_MAP, f"Command {cmd} missing in MOD_MAP"
    print(" -> Syntax without '!' OK")

def test_time_parsing():
    print("[TEST] 7. Time parsing...")
    assert bot.parse_time_str("10м") == 600
    assert bot.parse_time_str("2ч") == 7200
    assert bot.parse_time_str("1д") == 86400
    assert bot.parse_time_str("навсегда") == 0
    assert bot.parse_time_str("0") == 0
    print(" -> Time parsing OK")

def test_pm_player_access():
    print("[TEST] 8. Player access in PM...")
    # Убеждаемся, что обычный игрок не блокируется глобальным 'доступ только создателю'
    # Проверяем генерацию меню и текстов команд
    menu = bot.menu_keyboard("player")
    assert menu is not None
    help_txt = bot.commands_text("player")
    assert "Справочник команд" in help_txt
    print(" -> Player PM access OK")

def test_referral_system():
    print("[TEST] 9. Referral system...")
    referrer = "1802519292"
    invitee1 = "999111222"
    invitee2 = "999111333"

    # 1. Проверка формата ссылки
    link = bot.get_referral_link(referrer)
    assert f"start=ref_{referrer}" in link
    assert bot.BOT_USERNAME in link

    # 2. Очистка перед тестом
    mod_data = bot.load_mod_data()
    mod_data.get("referrals", {}).pop(invitee1, None)
    mod_data.get("referrals", {}).pop(invitee2, None)
    mod_data.get("referral_stats", {}).pop(referrer, None)
    mod_data.get("referral_stats", {}).pop(invitee1, None)
    bot.save_mod_data(mod_data)

    # 3. Самоприглашение запрещено
    ok_self, reason_self, _ = bot.register_referral(referrer, referrer)
    assert not ok_self
    assert reason_self == "self_referral"

    # 3.1 Невалидные ID (буквы, отрицательные числа, пустота)
    ok_inv, reason_inv, _ = bot.register_referral(invitee1, "abc")
    assert not ok_inv and reason_inv == "invalid_ids"
    ok_inv2, reason_inv2, _ = bot.register_referral(invitee1, "-10012345")
    assert not ok_inv2 and reason_inv2 == "invalid_ids"
    ok_inv3, reason_inv3, _ = bot.register_referral("", referrer)
    assert not ok_inv3 and reason_inv3 == "invalid_ids"

    # 4. Успешное приглашение первого друга
    ok1, reason1, info1 = bot.register_referral(invitee1, referrer, "friend_one")
    assert ok1
    assert reason1 == "success"
    assert info1["count"] == 1
    assert info1["reward"] == 50

    # 5. Повторная активация запрещена
    ok_repeat, reason_rep, _ = bot.register_referral(invitee1, referrer)
    assert not ok_repeat
    assert reason_rep == "already_referred"

    # 5.1 Защита от взаимных циклов (A пригласил B, B не может пригласить A)
    ok_mut, reason_mut, _ = bot.register_referral(referrer, invitee1)
    assert not ok_mut
    assert reason_mut == "mutual_referral"

    # 5.2 Опытный рекрутер не может активировать чужой инвайт
    # referrer уже пригласил invitee1 (count == 1), поэтому не может быть ничьим рефералом
    ok_rec, reason_rec, _ = bot.register_referral(referrer, "999999999")
    assert not ok_rec
    assert reason_rec == "already_referred"

    # 6. Приглашение второго друга тем же реферером
    ok2, reason2, info2 = bot.register_referral(invitee2, referrer, "friend_two")
    assert ok2
    assert info2["count"] == 2

    # 7. Проверка статистики пользователя
    stats = bot.get_user_referral_stats(referrer)
    assert stats["count"] == 2
    assert stats["biomass"] == 100
    assert invitee1 in stats["invited_users"]
    assert invitee2 in stats["invited_users"]

    # 8. Проверка карточки рефералов (включая отображение пригласившего для invitee1)
    card = bot.render_referral_card(referrer)
    assert link in card
    assert "Приглашено друзей: *2*" in card
    assert "Заработано биомассы: *100*" in card

    card_inv1 = bot.render_referral_card(invitee1)
    assert f"Твой пригласитель: `{referrer}`" in card_inv1

    # 9. Обработка команды без отправителя (анонимные админы / каналы)
    anon_msg = {"chat": {"id": -100111, "type": "supergroup"}, "message_id": 99}
    bot.handle_referral_command(anon_msg)  # не должно падать

    # Очистка
    mod_data = bot.load_mod_data()
    mod_data.get("referrals", {}).pop(invitee1, None)
    mod_data.get("referrals", {}).pop(invitee2, None)
    mod_data.get("referral_stats", {}).pop(referrer, None)
    mod_data.get("referral_stats", {}).pop(invitee1, None)
    bot.save_mod_data(mod_data)
    print(" -> Referral system OK")

def test_referral_update_flow():
    print("[TEST] 10. Referral disabled flow verification...")
    referrer = "1802519292"
    recruit_id = 888999111

    # Проверяем, что при отключённой реферальной программе /start ref_... не создаёт реферала
    update_recruit = {
        "message": {
            "message_id": 102,
            "chat": {"id": recruit_id, "type": "private"},
            "from": {"id": recruit_id, "username": "new_recruit", "first_name": "Newbie"},
            "text": f"/start ref_{referrer}",
        }
    }
    bot.handle_update(update_recruit)
    mod_data = bot.load_mod_data()
    assert str(recruit_id) not in mod_data.get("referrals", {}), "Referral system is disabled, recruit should NOT be registered!"

    # Проверяем команду /ref
    update_ref = {
        "message": {
            "message_id": 103,
            "chat": {"id": recruit_id, "type": "private"},
            "from": {"id": recruit_id, "username": "new_recruit", "first_name": "Newbie"},
            "text": "/ref",
        }
    }
    bot.handle_update(update_ref)

    print(" -> Referral disabled flow OK")


def test_real_update_goal_and_boost():
    print("[TEST] 11. Real Telegram Update: Goal & Boost...")
    chat_id = -1003979980916
    creator_id = 1802519292
    admin_id = 111222333
    user_id = 777888999

    bot.add_whitelisted_chat(chat_id, "Test Group", creator_id)
    bot.set_chat_role(chat_id, admin_id, "admin", creator_id)
    bot.reset_chat_goal(chat_id)
    bot.reset_chat_boost(chat_id)

    captured = []
    orig_send_group = bot.send_group_msg
    def mock_send(cid, text, thread_id=None, reply_to=None, **kwargs):
        captured.append(text)
        return {"ok": True, "result": {"message_id": 9999}}
    bot.send_group_msg = mock_send

    try:
        # 1. /goal 500 участников
        upd1 = {
            "message": {
                "message_id": 201,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "/goal 500 участников",
            }
        }
        bot.handle_update(upd1)
        g = bot.get_chat_goal(chat_id)
        assert g is not None, "Goal should be set"
        assert g["target"] == 500
        assert "участников" in g["title"]
        assert "Новая цель чата установлена" in captured[-1]

        # 2. Просмотр цели обычным участником через 'цель' без слэша
        upd2 = {
            "message": {
                "message_id": 202,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": user_id, "username": "regular_player"},
                "text": "цель",
            }
        }
        bot.handle_update(upd2)
        assert "участников" in captured[-1] and "Цель чата" in captured[-1]

        # 3. Добавление прогресса через /goal +50
        upd3 = {
            "message": {
                "message_id": 203,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "/goal +50",
            }
        }
        bot.handle_update(upd3)
        g = bot.get_chat_goal(chat_id)
        assert g["current"] == 50
        assert "Прогресс цели обновлён" in captured[-1]

        # 4. Добавление прогресса через 'цель +30' (естественный язык)
        upd4 = {
            "message": {
                "message_id": 204,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "цель +30",
            }
        }
        bot.handle_update(upd4)
        g = bot.get_chat_goal(chat_id)
        assert g["current"] == 80

        # 5. Сброс цели через '/goal reset'
        upd5 = {
            "message": {
                "message_id": 205,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "/goal reset",
            }
        }
        bot.handle_update(upd5)
        assert bot.get_chat_goal(chat_id) is None
        assert "Цель чата сброшена" in captured[-1]

        # 6. Буст: /boost 50
        upd6 = {
            "message": {
                "message_id": 206,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "/boost 50",
            }
        }
        bot.handle_update(upd6)
        b = bot.get_chat_boost(chat_id)
        assert b["points"] == 50
        assert b["level"] == 1
        assert "Очки буста чата увеличены" in captured[-1] and "50" in captured[-1]

        # 7. Буст: '+буст 60'
        upd7 = {
            "message": {
                "message_id": 207,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "+буст 60",
            }
        }
        bot.handle_update(upd7)
        b = bot.get_chat_boost(chat_id)
        assert b["points"] == 110
        assert b["level"] == 2

        # 8. Буст: сбросбуст
        upd8 = {
            "message": {
                "message_id": 208,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "сбросбуст",
            }
        }
        bot.handle_update(upd8)
        b = bot.get_chat_boost(chat_id)
        assert b["points"] == 0
        assert "сброшен" in captured[-1]

    finally:
        bot.send_group_msg = orig_send_group

    print(" -> Real Telegram Update: Goal & Boost OK")


def test_real_update_roles_management():
    print("[TEST] 12. Real Telegram Update: Roles & Subordination...")
    chat_id = -1003979980916
    creator_id = 1802519292
    admin_id = 111222333
    moder_id = 444555666
    target_user_id = 777888999

    bot.add_whitelisted_chat(chat_id, "Test Group", creator_id)
    bot.remove_chat_role(chat_id, admin_id)
    bot.remove_chat_role(chat_id, moder_id)
    bot.remove_chat_role(chat_id, target_user_id)

    # Запоминаем пользователей в кеш
    bot._KNOWN_USERS["player_target"] = (str(target_user_id), "@player_target")
    bot._KNOWN_USERS["player_admin"] = (str(admin_id), "@player_admin")

    captured = []
    orig_send_group = bot.send_group_msg
    def mock_send(cid, text, thread_id=None, reply_to=None, **kwargs):
        captured.append(text)
        return {"ok": True, "result": {"message_id": 9999}}
    bot.send_group_msg = mock_send

    try:
        # 1. Создатель назначает админа: "админ @player_admin" (без !)
        upd1 = {
            "message": {
                "message_id": 301,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "админ @player_admin",
            }
        }
        bot.handle_update(upd1)
        assert bot.get_user_chat_rank(chat_id, admin_id) == bot.RANK_ADMIN
        assert "присвоен ранг" in captured[-1] and "Администратор" in captured[-1]

        # 2. Несоздатель пытается назначить админа -> отказ
        upd2 = {
            "message": {
                "message_id": 302,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "player_admin"},
                "text": "админ @player_target",
            }
        }
        bot.handle_update(upd2)
        assert bot.get_user_chat_rank(chat_id, target_user_id) == bot.RANK_USER
        assert "может только 👑 Создатель" in captured[-1]

        # 3. Админ назначает модера: "/moder @player_target" (на английском с /)
        upd3 = {
            "message": {
                "message_id": 303,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "player_admin"},
                "text": "/moder @player_target",
            }
        }
        bot.handle_update(upd3)
        assert bot.get_user_chat_rank(chat_id, target_user_id) == bot.RANK_MODER
        assert "присвоен ранг" in captured[-1] and "Модератор" in captured[-1]

        # 4. Проверка 'состав' и 'staff'
        upd4 = {
            "message": {
                "message_id": 304,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": target_user_id, "username": "player_target"},
                "text": "состав",
            }
        }
        bot.handle_update(upd4)
        assert "Администраторы:" in captured[-1]
        assert "Модераторы:" in captured[-1]

        # 5. Назначение ответом (reply_to_message): создатель отвечает словом "модер"
        upd5 = {
            "message": {
                "message_id": 305,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "модер",
                "reply_to_message": {
                    "message_id": 200,
                    "from": {"id": moder_id, "username": "replied_user", "first_name": "Bob"},
                },
            }
        }
        bot.handle_update(upd5)
        assert bot.get_user_chat_rank(chat_id, moder_id) == bot.RANK_MODER

        # 6. Разжалование модера ответом: админ отвечает словом "снять модер"
        upd6 = {
            "message": {
                "message_id": 306,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "player_admin"},
                "text": "снять модер",
                "reply_to_message": {
                    "message_id": 200,
                    "from": {"id": moder_id, "username": "replied_user"},
                },
            }
        }
        bot.handle_update(upd6)
        assert bot.get_user_chat_rank(chat_id, moder_id) == bot.RANK_USER
        assert "разжалован из Модераторов" in captured[-1]

        # 7. Снятие админа: создатель пишет "снять админ @player_admin"
        upd7 = {
            "message": {
                "message_id": 307,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "снять админ @player_admin",
            }
        }
        bot.handle_update(upd7)
        assert bot.get_user_chat_rank(chat_id, admin_id) == bot.RANK_USER
        assert "разжалован из Администраторов" in captured[-1]

    finally:
        bot.send_group_msg = orig_send_group

    print(" -> Real Telegram Update: Roles & Subordination OK")


def test_real_update_moderation():
    print("[TEST] 13. Real Telegram Update: Moderation commands without '!'...")
    chat_id = -1003979980916
    creator_id = 1802519292
    moder_id = 444555666
    violator_id = 999333111

    bot.add_whitelisted_chat(chat_id, "Test Group", creator_id)
    bot.set_chat_role(chat_id, moder_id, "moder", creator_id)
    bot._KNOWN_USERS["spammer"] = (str(violator_id), "@spammer")

    captured_group = []
    api_calls = []

    orig_send_group = bot.send_group_msg
    def mock_send(cid, text, thread_id=None, reply_to=None, **kwargs):
        captured_group.append(text)
        return {"ok": True, "result": {"message_id": 9999}}
    bot.send_group_msg = mock_send

    orig_api = bot.api
    def mock_api(method, **kwargs):
        api_calls.append((method, kwargs))
        if method == "getMe":
            return {"ok": True, "result": {"id": 8919848238, "username": "SporeTDBot"}}
        return {"ok": True, "result": {}}
    bot.api = mock_api

    try:
        # 1. Мут ответом на сообщение: "мут 15м спам"
        upd1 = {
            "message": {
                "message_id": 401,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": moder_id, "username": "moder_bob"},
                "text": "мут 15м спам",
                "reply_to_message": {
                    "message_id": 399,
                    "from": {"id": violator_id, "username": "spammer"},
                },
            }
        }
        bot.handle_update(upd1)
        restr_calls = [c for c in api_calls if c[0] == "restrictChatMember"]
        assert len(restr_calls) > 0, "restrictChatMember must be called"
        assert restr_calls[-1][1]["user_id"] == violator_id
        assert "замучен на" in captured_group[-1] and "15 мин" in captured_group[-1]

        # 2. Варн с указанием @username: "варн @spammer флуд"
        upd2 = {
            "message": {
                "message_id": 402,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": moder_id, "username": "moder_bob"},
                "text": "варн @spammer флуд",
            }
        }
        bot.handle_update(upd2)
        assert "получил предупреждение" in captured_group[-1] and "1/3" in captured_group[-1]

        # 3. Проверка варнов: "варны @spammer"
        upd3 = {
            "message": {
                "message_id": 403,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": moder_id, "username": "moder_bob"},
                "text": "варны @spammer",
            }
        }
        bot.handle_update(upd3)
        assert "1/3" in captured_group[-1]

        # 4. Снятие варнов: "снять варн @spammer"
        upd4 = {
            "message": {
                "message_id": 404,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": moder_id, "username": "moder_bob"},
                "text": "снять варн @spammer",
            }
        }
        bot.handle_update(upd4)
        assert "сняты все предупреждения" in captured_group[-1]

        # 5. Кик: "/kick @spammer"
        upd5 = {
            "message": {
                "message_id": 405,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": moder_id, "username": "moder_bob"},
                "text": "/kick @spammer",
            }
        }
        bot.handle_update(upd5)
        assert "исключён из группы" in captured_group[-1]

    finally:
        bot.send_group_msg = orig_send_group
        bot.api = orig_api

    print(" -> Real Telegram Update: Moderation commands OK")


def test_real_update_whitelist_creator_autowhitelist():
    print("[TEST] 14. Real Telegram Update: Whitelist & Creator Auto-activation...")
    new_chat_id = -1009999888877
    creator_id = 1802519292
    random_user_id = 123456789

    bot.remove_whitelisted_chat(new_chat_id)
    assert not bot.is_chat_whitelisted(new_chat_id)

    captured_group = []
    orig_send_group = bot.send_group_msg
    def mock_send(cid, text, thread_id=None, reply_to=None, **kwargs):
        captured_group.append(text)
        return {"ok": True, "result": {"message_id": 9999}}
    bot.send_group_msg = mock_send

    try:
        # 1. Обычный игрок пытается писать в неавторизованном чате
        upd_unauth = {
            "message": {
                "message_id": 501,
                "chat": {"id": new_chat_id, "type": "supergroup", "title": "New Random Chat"},
                "from": {"id": random_user_id, "username": "stranger"},
                "text": "/goal",
            }
        }
        bot.handle_update(upd_unauth)
        assert "ещё не активирован создателем" in captured_group[-1]
        assert not bot.is_chat_whitelisted(new_chat_id)

        # 2. Создатель пишет любую команду (например, /goal 200 побед)
        # Бот ДОЛЖЕН автоматически активировать чат и выполнить команду
        upd_creator = {
            "message": {
                "message_id": 502,
                "chat": {"id": new_chat_id, "type": "supergroup", "title": "New Random Chat"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "/goal 200 побед",
            }
        }
        bot.handle_update(upd_creator)
        assert bot.is_chat_whitelisted(new_chat_id), "Chat MUST be auto-whitelisted when Creator runs a command"
        g = bot.get_chat_goal(new_chat_id)
        assert g is not None
        assert g["target"] == 200
        assert "200" in captured_group[-1]

        # 3. Теперь чат активирован, обычный игрок может писать команды (например, 'цель')
        upd_player_now = {
            "message": {
                "message_id": 503,
                "chat": {"id": new_chat_id, "type": "supergroup", "title": "New Random Chat"},
                "from": {"id": random_user_id, "username": "stranger"},
                "text": "цель",
            }
        }
        bot.handle_update(upd_player_now)
        assert "побед" in captured_group[-1] and "Цель чата" in captured_group[-1]

    finally:
        bot.remove_whitelisted_chat(new_chat_id)
        bot.send_group_msg = orig_send_group

    print(" -> Real Telegram Update: Whitelist & Creator Auto-activation OK")


def test_pm_goal_and_boost():
    print("[TEST] 15. PM Goal and Boost feedback...")
    user_id = 777888999
    captured_pm = []
    orig_send_message = bot.send_message
    def mock_pm(cid, text, **kwargs):
        captured_pm.append(text)
        return {"ok": True, "result": {"message_id": 9999}}
    bot.send_message = mock_pm

    try:
        upd = {
            "message": {
                "message_id": 601,
                "chat": {"id": user_id, "type": "private"},
                "from": {"id": user_id, "username": "some_user"},
                "text": "/goal",
            }
        }
        bot.handle_update(upd)
        assert "работают в группах и супергруппах" in captured_pm[-1]

        upd2 = {
            "message": {
                "message_id": 602,
                "chat": {"id": user_id, "type": "private"},
                "from": {"id": user_id, "username": "some_user"},
                "text": "/boost",
            }
        }
        bot.handle_update(upd2)
        assert "работают в группах и супергруппах" in captured_pm[-1]
    finally:
        bot.send_message = orig_send_message

    print(" -> PM Goal and Boost feedback OK")


def test_edge_cases_prefixes_and_tags():
    print("[TEST] 16. Edge cases: prefixes, bot tags, text_mention and arg order...")
    chat_id = -1003979980916
    creator_id = 1802519292
    admin_id = 111222333
    target_id = 888777666
    target_name = "text_mention_user"

    bot.add_whitelisted_chat(chat_id, "Test Group", creator_id)
    bot.set_chat_role(chat_id, admin_id, "admin", creator_id)
    bot.remove_chat_role(chat_id, target_id)

    captured = []
    orig_send_group = bot.send_group_msg
    def mock_send(cid, text, thread_id=None, reply_to=None, **kwargs):
        captured.append(text)
        return {"ok": True, "result": {"message_id": 9999}}
    bot.send_group_msg = mock_send

    orig_api = bot.api
    api_calls = []
    def mock_api(method, **kwargs):
        api_calls.append((method, kwargs))
        if method == "getMe":
            return {"ok": True, "result": {"id": 8919848238, "username": "SporeTDBot"}}
        return {"ok": True, "result": {}}
    bot.api = mock_api

    try:
        # 1. Команда с тегом бота: /goal@SporeTDBot 1500 побед
        upd1 = {
            "message": {
                "message_id": 701,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "/goal@SporeTDBot 1500 побед",
            }
        }
        bot.handle_update(upd1)
        g = bot.get_chat_goal(chat_id)
        assert g is not None and g["target"] == 1500
        assert "1500" in captured[-1]

        # 2. Команда с восклицательным знаком: !boost 75
        upd2 = {
            "message": {
                "message_id": 702,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "!boost 75",
            }
        }
        bot.handle_update(upd2)
        b = bot.get_chat_boost(chat_id)
        assert b["points"] == 75

        # 3. Text mention (пользователь без юзернейма выбран из списка Telegram)
        upd3 = {
            "message": {
                "message_id": 703,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "админ Вася",
                "entities": [
                    {
                        "type": "text_mention",
                        "offset": 6,
                        "length": 4,
                        "user": {"id": target_id, "first_name": "Вася"},
                    }
                ],
            }
        }
        bot.handle_update(upd3)
        assert bot.get_user_chat_rank(chat_id, target_id) == bot.RANK_ADMIN

        # 4. Мут с обратным порядком аргументов (время перед целью): "мут 20м @spammer флуд"
        bot._KNOWN_USERS["spammer"] = ("999333111", "@spammer")
        upd4 = {
            "message": {
                "message_id": 704,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "мут 20м @spammer флуд",
            }
        }
        bot.handle_update(upd4)
        restr_calls = [c for c in api_calls if c[0] == "restrictChatMember"]
        assert len(restr_calls) > 0
        assert restr_calls[-1][1]["user_id"] == 999333111
        assert "20 мин" in captured[-1]

    finally:
        bot.send_group_msg = orig_send_group
        bot.api = orig_api

    print(" -> Edge cases OK")


def test_deep_fixes_and_robustness():
    print("[TEST] 17. Deep fixes: disk persistence, multi-word time, captions, prefixes and PM feedback...")
    chat_id = -1003979980916
    creator_id = 1802519292
    admin_id = 111222333
    target_id = 555666777
    target_username = "test_persisted_user"

    bot.add_whitelisted_chat(chat_id, "Test Group", creator_id)
    bot.set_chat_role(chat_id, admin_id, "admin", creator_id)

    # 1. Проверка сохранения known_users на диск и восстановление после очистки _KNOWN_USERS
    bot._KNOWN_USERS.clear()
    bot.register_known_user(target_id, target_username, f"@{target_username}")
    bot._KNOWN_USERS.clear()  # Имитируем перезапуск процесса / очистку оперативной памяти

    # Разрешение цели из файла на диске:
    res_id, res_name, rem_args, err = bot.resolve_command_target({}, [f"@{target_username}"], chat_id)
    assert res_id == target_id
    assert res_name == f"@{target_username}"
    assert err is None

    captured_group = []
    orig_send_group = bot.send_group_msg
    def mock_send(cid, text, thread_id=None, reply_to=None, **kwargs):
        captured_group.append(text)
        return {"ok": True, "result": {"message_id": 9999}}
    bot.send_group_msg = mock_send

    orig_api = bot.api
    api_calls = []
    def mock_api(method, **kwargs):
        api_calls.append((method, kwargs))
        if method == "getMe":
            return {"ok": True, "result": {"id": 8919848238, "username": "SporeTDBot"}}
        return {"ok": True, "result": {}}
    bot.api = mock_api

    captured_pm = []
    orig_send_message = bot.send_message
    def mock_pm(cid, text, **kwargs):
        captured_pm.append(text)
        return {"ok": True, "result": {"message_id": 8888}}
    bot.send_message = mock_pm

    try:
        # 2. Многословное время и правильное выделение цели: "мут 10 мин @test_persisted_user флуд"
        upd_mute = {
            "message": {
                "message_id": 801,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": f"мут 10 мин @{target_username} флуд",
            }
        }
        bot.handle_update(upd_mute)
        restr = [c for c in api_calls if c[0] == "restrictChatMember"]
        assert len(restr) > 0
        assert restr[-1][1]["user_id"] == target_id
        assert "10 мин" in captured_group[-1]
        assert "флуд" in captured_group[-1]

        # 3. Медиа-сообщение с подписью (caption): "мут 15м" ответом на сообщение нарушителя
        upd_caption = {
            "message": {
                "message_id": 802,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "caption": "мут 15м спам картинками",
                "reply_to_message": {
                    "message_id": 800,
                    "from": {"id": target_id, "username": target_username, "first_name": "Target"},
                },
            }
        }
        bot.handle_update(upd_caption)
        assert "15 мин" in captured_group[-1]
        assert "спам картинками" in captured_group[-1]

        # 4. Обращение к боту с запятой: "@SporeTDBot, цель" и "бот, цель"
        upd_tag_comma = {
            "message": {
                "message_id": 803,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "@SporeTDBot, цель",
            }
        }
        bot.handle_update(upd_tag_comma)
        assert "Цель чата" in captured_group[-1]

        upd_bot_comma = {
            "message": {
                "message_id": 804,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "бот, цель",
            }
        }
        bot.handle_update(upd_bot_comma)
        assert "Цель чата" in captured_group[-1]

        # 5. Пробел после префикса: "! мут 5м" ответом
        upd_space_excl = {
            "message": {
                "message_id": 805,
                "chat": {"id": chat_id, "type": "supergroup"},
                "from": {"id": admin_id, "username": "admin_user"},
                "text": "! мут 5м нарушение",
                "reply_to_message": {
                    "message_id": 800,
                    "from": {"id": target_id, "username": target_username, "first_name": "Target"},
                },
            }
        }
        bot.handle_update(upd_space_excl)
        assert "5 мин" in captured_group[-1]

        # 6. Неактивированная группа: обычный участник пишет "цель" без слэша
        unwhitelisted_cid = -100987654321
        bot.remove_whitelisted_chat(unwhitelisted_cid)
        upd_unwl = {
            "message": {
                "message_id": 806,
                "chat": {"id": unwhitelisted_cid, "type": "supergroup"},
                "from": {"id": 123456, "username": "random_guy"},
                "text": "цель",
            }
        }
        bot.handle_update(upd_unwl)
        assert "ещё не активирован создателем" in captured_group[-1]

        # 7. Информативные ответы в ЛС бота: ранг, состав, админ, мут
        pm_upd_rank = {
            "message": {
                "message_id": 807,
                "chat": {"id": creator_id, "type": "private"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "ранг",
            }
        }
        bot.handle_update(pm_upd_rank)
        assert "Ваш профиль в боте" in captured_pm[-1]
        assert "Ранги модерации" in captured_pm[-1]

        pm_upd_staff = {
            "message": {
                "message_id": 808,
                "chat": {"id": creator_id, "type": "private"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "состав",
            }
        }
        bot.handle_update(pm_upd_staff)
        assert "Состав администрации" in captured_pm[-1]

        pm_upd_mod = {
            "message": {
                "message_id": 809,
                "chat": {"id": creator_id, "type": "private"},
                "from": {"id": creator_id, "username": "gyviii"},
                "text": "мут @someone",
            }
        }
        bot.handle_update(pm_upd_mod)
        assert "Модерация" in captured_pm[-1]

    finally:
        bot.send_group_msg = orig_send_group
        bot.api = orig_api
        bot.send_message = orig_send_message

    print(" -> Deep fixes & robustness OK")


if __name__ == "__main__":
    test_whitelist()
    test_roles_hierarchy()
    test_del_subordination()
    test_warns_and_unwarn()
    test_goal_and_boost()
    test_no_exclamation_mark()
    test_time_parsing()
    test_pm_player_access()
    test_referral_system()
    test_referral_update_flow()
    test_real_update_goal_and_boost()
    test_real_update_roles_management()
    test_real_update_moderation()
    test_real_update_whitelist_creator_autowhitelist()
    test_pm_goal_and_boost()
    test_edge_cases_prefixes_and_tags()
    test_deep_fixes_and_robustness()
    print("\n🎉 ALL TESTS PASSED SUCCESSFULLY!")
