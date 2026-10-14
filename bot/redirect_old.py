# -*- coding: utf-8 -*-
"""Старый бот-переадресация: отвечает всем, что игра переехала на нового бота.

Токен берётся из OLD_BOT_TOKEN (секрет GitHub) — это токен ПРЕЖНЕГО бота.
Пишет только сообщение о переезде и кнопку перехода. Больше ничего не делает.
"""

import os
import time

import requests

BOT_TOKEN = os.environ.get("OLD_BOT_TOKEN")

# Локальный config.py (не в Git) может содержать OLD_BOT_TOKEN.
try:
    import config

    BOT_TOKEN = BOT_TOKEN or getattr(config, "OLD_BOT_TOKEN", None)
except ImportError:
    pass

if not BOT_TOKEN:
    raise SystemExit("Не задан OLD_BOT_TOKEN (секрет или config.py).")

API = f"https://api.telegram.org/bot{BOT_TOKEN}"

NEW_USERNAME = "@SporeTDBot"
NEW_LINK = "https://t.me/SporeTDBot"
TEXT = (
    "⚠️ Этот бот больше не работает.\n\n"
    f"Игра переехала на новый бот: {NEW_USERNAME}\n"
    f"{NEW_LINK}"
)
KEYBOARD = {"inline_keyboard": [[{"text": "Перейти в новый бот", "url": NEW_LINK}]]}


def api(method, **params):
    return requests.post(f"{API}/{method}", json=params, timeout=40).json()


def main():
    print("Старт редирект-бота...")

    me = api("getMe")
    if not me.get("ok"):
        print("Ошибка авторизации старого бота:", me)
        return
    print("Старый бот:", me["result"]["username"])

    api("deleteWebhook", drop_pending_updates=False)

    offset = 0
    while True:
        try:
            updates = api("getUpdates", offset=offset, timeout=30).get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                message = update.get("message") or update.get("edited_message")
                callback = update.get("callback_query")

                chat_id = None
                if message:
                    chat_id = message.get("chat", {}).get("id")
                elif callback:
                    chat_id = callback.get("message", {}).get("chat", {}).get("id")

                if chat_id:
                    api("sendMessage", chat_id=chat_id, text=TEXT, reply_markup=KEYBOARD)
                if callback:
                    api("answerCallbackQuery", callback_query_id=callback.get("id"))
        except KeyboardInterrupt:
            print("Остановлено.")
            break
        except Exception as error:
            print("Ошибка сети, повтор через 3 сек:", error)
            time.sleep(3)


if __name__ == "__main__":
    main()
