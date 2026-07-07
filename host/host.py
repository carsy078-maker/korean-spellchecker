import sys
import json
import struct
import subprocess
import os
import re
import shutil
import logging

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host.log")
logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

SYSTEM_PROMPT = (
    "너는 한국어 맞춤법/띄어쓰기 교정기다. 사용자가 준 문장을 표준 맞춤법에 맞게 "
    "교정한다. 의미는 절대 바꾸지 말고 맞춤법/띄어쓰기/명백한 오타만 고쳐라. "
    "고칠 곳이 없으면 원문을 그대로 corrected에 넣고 edits는 빈 배열로 반환한다. "
    "다른 설명, 인사, 코드블록 없이 아래 형식의 JSON 한 줄만 출력한다:\n"
    '{"corrected":"<교정문>","edits":[{"before":"<원래표현>","after":"<교정표현>","reason":"<이유>"}]}'
)

DEFAULT_MODEL = "claude-haiku-4-5-20251001"
CLAUDE_TIMEOUT_SEC = 180


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        sys.exit(0)
    length = struct.unpack("<I", raw_len)[0]
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def strip_code_fence(text):
    text = text.strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return text


def extract_json_object(text):
    """모델이 JSON 앞뒤에 다른 텍스트를 붙였을 경우를 대비해 첫 '{'~마지막 '}' 구간을 추출한다."""
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("응답에서 JSON 객체를 찾을 수 없음: " + text[:200])
    return text[start:end + 1]


def run_claude(text, model):
    claude_path = shutil.which("claude")
    if not claude_path:
        raise RuntimeError(
            "PATH에서 'claude' 실행 파일을 찾을 수 없음. "
            "claude Code CLI가 설치되어 있고 사용자 PATH에 등록돼 있는지 확인하세요."
        )

    env = os.environ.copy()
    env.pop("ANTHROPIC_API_KEY", None)  # 구독(OAuth) 세션 강제 사용
    # CLI 시작 시 자동 업데이트 체크/다운로드, 텔레메트리 등 불필요한 네트워크 작업을
    # 끈다. (가끔 이 작업들이 요청을 수십 초 지연시켜 타임아웃을 유발함)
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    env["DISABLE_AUTOUPDATER"] = "1"
    env["DISABLE_TELEMETRY"] = "1"
    env["DISABLE_ERROR_REPORTING"] = "1"
    env["DISABLE_BUG_COMMAND"] = "1"

    user_prompt = f"입력:\n{text}"

    cmd = [
        claude_path,
        "-p", user_prompt,
        "--system-prompt", SYSTEM_PROMPT,
        "--output-format", "json",
        "--tools", "",
        "--model", model,
    ]

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
        encoding="utf-8",
        timeout=CLAUDE_TIMEOUT_SEC,
    )

    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI 실행 실패 (code={proc.returncode}): {proc.stderr.strip()[:500]}")

    try:
        cli_out = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"claude CLI 출력 파싱 실패: {e}; raw={proc.stdout[:500]}")

    if cli_out.get("is_error"):
        raise RuntimeError(f"claude CLI 오류 응답: {cli_out.get('result')}")

    result_text = cli_out.get("result")
    if not isinstance(result_text, str):
        raise RuntimeError(f"예상치 못한 CLI 출력 구조 (result 필드 없음): {json.dumps(cli_out)[:500]}")

    return result_text


def correct(text, model):
    raw = run_claude(text, model)
    cleaned = strip_code_fence(raw)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # 재시도 없이, 텍스트 중 JSON 객체 구간만 추출해 한 번 더 시도
    extracted = extract_json_object(cleaned)
    return json.loads(extracted)


def main():
    try:
        msg = read_message()
        text = msg.get("text", "")
        model = msg.get("model") or DEFAULT_MODEL

        if not text.strip():
            send_message({"ok": False, "error": "빈 텍스트"})
            return

        result = correct(text, model)
        send_message({"ok": True, "result": result})
    except subprocess.TimeoutExpired:
        logging.exception("claude CLI 타임아웃")
        send_message({"ok": False, "error": "응답 시간이 너무 오래 걸립니다. 텍스트를 더 짧게 나눠 검사하거나 잠시 후 다시 시도하세요."})
    except Exception as e:
        logging.exception("호스트 처리 중 오류")
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
