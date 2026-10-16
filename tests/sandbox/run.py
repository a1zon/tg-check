"""
Запуск задачи панели в песочнице: настоящий скрипт, подменённый Telegram.

    TG_PANEL_DIR=<папка профиля песочницы> venv-tg/bin/python tests/sandbox/run.py \
        followup.py --account a1

tglib.connect/aclose подменяются заглушкой (fake_tg), llm.chat — фальшивой
моделью (если TG_FAKE_LLM задан). Стандартную библиотеку не трогаем: паузы
задач настоящие, поэтому запускать под сторожем (watch.sh).
"""
import os
import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
if not os.environ.get("TG_PANEL_DIR"):
    raise SystemExit("нужен TG_PANEL_DIR — папка профиля песочницы (make_profile.py)")
if Path(os.environ["TG_PANEL_DIR"]).resolve() == REPO:
    raise SystemExit("TG_PANEL_DIR указывает на папку кода — это не песочница")

sys.path.insert(0, str(REPO))
sys.path.insert(1, str(HERE))
import tglib      # noqa: E402
import fake_tg    # noqa: E402

tglib.connect = fake_tg.connect
tglib.aclose = fake_tg.aclose
if os.environ.get("TG_FAKE_LLM"):
    import llm    # noqa: E402
    llm.chat = fake_tg.fake_llm_chat

script = REPO / sys.argv[1]
sys.argv = [str(script)] + sys.argv[2:]
runpy.run_path(str(script), run_name="__main__")
