"""모여라 AI 백엔드 (FastAPI + faster-whisper) — 뼈대

실행
    pip install -r requirements.txt
    uvicorn server:app --host 127.0.0.1 --port 8000        # 또는: python server.py

프론트 연결 (브라우저 콘솔에서 한 번)
    localStorage.setItem('moyeora.backend', 'http://127.0.0.1:8000')

API 계약 (app.js 의 '파이썬(GPU) 백엔드 연동 스텁'과 동일)
    GET  /health  -> { stt, intent, gpu, ... }
    POST /stt     multipart(audio, lang)                     -> { text }
    POST /intent  json({ text, lang, vocabulary })           -> { tokens, budget, minutes, area }

GPU 메모
    faster-whisper(CTranslate2)의 CUDA 추론에는 CUDA 12 런타임 + cuBLAS + cuDNN 9 가 필요하다.
    라이브러리가 없으면 자동으로 CPU 로 내려가므로(WHISPER_DEVICE=auto) 서버는 계속 동작한다.

개인정보
    오디오는 디스크에 쓰지 않고 메모리에서만 처리한 뒤 버린다. 인식된 문장은 로그에 남기지 않는다.
"""
from __future__ import annotations

import io
import logging
import os
import re
import subprocess
import threading
import time
import wave
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("moyeora")

# ───────────────────────────── 설정 (환경변수) ─────────────────────────────
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "")          # 비우면 장치에 맞춰 자동 선택 (GPU: large-v3 / CPU: small)
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto")     # auto | cuda | cpu
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "auto")   # auto | float16 | int8_float16 | int8
STT_MAX_BYTES = int(os.getenv("STT_MAX_BYTES", str(5 * 1024 * 1024)))  # 업로드 상한 (약 15초 분량 녹음이면 충분)
STT_CONCURRENCY = int(os.getenv("STT_CONCURRENCY", "1"))  # 동시에 추론할 요청 수
STT_HINT = os.getenv("STT_HINT", "강남역, 홍대입구역, 잠실역, 왕십리역, 판교역, 대전역, 스터디카페, 주차")  # 지명 인식률 보조
INTENT_BACKEND = os.getenv("INTENT_BACKEND", "rules")    # rules | llm (llm 은 parse_with_llm 구현 후 사용)
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]  # 운영에서는 실제 도메인으로 제한


# ───────────────────────────── 음성 인식 (faster-whisper) ─────────────────────────────
@dataclass
class STTState:
    model: Any = None
    device: str = "cpu"
    compute_type: str = ""
    model_name: str = ""
    gpu: str = ""
    error: str = ""
    slots: threading.Semaphore = field(default_factory=lambda: threading.Semaphore(STT_CONCURRENCY))


stt = STTState()


def _cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def _gpu_name() -> str:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=3,
        )
        lines = out.stdout.strip().splitlines() if out.returncode == 0 else []
        return lines[0].strip() if lines else "CUDA GPU"
    except Exception:
        return "CUDA GPU"


def _silent_wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


def _build_model(name: str, device: str, compute: str):
    """모델을 만들고 1초 무음 WAV 로 워밍업한다.

    - CUDA 라이브러리(cuBLAS/cuDNN) 누락은 로드가 아니라 첫 추론에서 터지므로 여기서 미리 확인한다.
    - 실제 요청과 같이 '오디오 바이트'를 넣어 디코딩 경로(PyAV)까지 검증한다. (numpy 배열을 넣으면 이 경로를 건너뛴다)
    """
    from faster_whisper import WhisperModel

    model = WhisperModel(name, device=device, compute_type=compute)
    segments, _ = model.transcribe(io.BytesIO(_silent_wav()), language="ko")
    list(segments)
    return model


def load_stt() -> None:
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:  # 미설치여도 서버는 뜨고 /health 에서 stt=false → 프론트가 브라우저 인식으로 대체
        stt.error = "faster-whisper 를 불러오지 못했어요"
        log.warning("%s: %s", stt.error, exc)
        return

    want_cuda = WHISPER_DEVICE == "cuda" or (WHISPER_DEVICE == "auto" and _cuda_available())
    attempts = [("cuda", WHISPER_COMPUTE if WHISPER_COMPUTE != "auto" else "float16")] if want_cuda else []
    if WHISPER_DEVICE != "cuda":  # cuda 실패 시 CPU 로 내려가기 (auto/cpu)
        attempts.append(("cpu", WHISPER_COMPUTE if WHISPER_COMPUTE != "auto" else "int8"))

    for device, compute in attempts:
        name = WHISPER_MODEL or ("large-v3" if device == "cuda" else "small")
        try:
            started = time.perf_counter()
            stt.model = _build_model(name, device, compute)
            stt.device, stt.compute_type, stt.model_name = device, compute, name
            stt.gpu = _gpu_name() if device == "cuda" else ""
            stt.error = ""
            log.info("STT 준비 완료: model=%s device=%s compute=%s (%.1fs)", name, device, compute, time.perf_counter() - started)
            return
        except Exception as exc:
            stt.error = f"{device} 로드 실패"
            log.warning("STT %s/%s 로드 실패: %s", name, device, exc)
    stt.model = None


# ───────────────────────────── 의도 파싱 ─────────────────────────────
# 프론트(app.js)의 로컬 규칙과 같은 어휘. 키는 조건 칩에 들어가는 문구다.
INTENT_RULES: List = [
    (t, re.compile(p, re.I)) for t, p in [
        ("스터디·작업하기 좋은 곳", r"스터디|공부|작업|노트북|과제|코워킹"),
        ("회식", r"회식|동아리|뒤풀이"),
        ("식사", r"식사|밥|점심|저녁|런치|디너"),
        ("공원·산책", r"공원|산책|피크닉|야외"),
        ("데이트", r"데이트|연인|커플|소개팅"),
        ("미팅", r"미팅|비즈니스|회의|면접"),
        ("전시·공연", r"전시|공연|영화|박물관|미술|연극|뮤지컬"),
        ("카페·디저트", r"카페|커피|디저트|베이커리"),
        ("이자카야", r"이자카야|술집|맥주|한잔|호프"),
        ("고기·구이", r"고기|구이|삼겹|갈비|곱창"),
        ("한식", r"한식|국밥|백반|찌개"),
        ("양식·파스타", r"양식|파스타|스테이크|피자"),
        ("브런치", r"브런치"),
        ("조용한 곳", r"조용|한적|차분|고요"),
        ("감성적인", r"감성|예쁜|아늑|인스타"),
        ("분위기 좋은 곳", r"분위기"),
        ("활기찬", r"활기|북적|시끌|신나"),
        ("프라이빗", r"프라이빗|단독|독채"),
        ("뷰 좋은 곳", r"뷰|전망|야경|경치|루프탑"),
        ("주차 가능", r"주차"),
        ("룸 있는 곳", r"룸|별실"),
        ("단체석 가능", r"단체석|단체|넓은 자리"),
        ("24시", r"24\s*시|밤샘|새벽"),
        ("휠체어 접근 가능", r"휠체어|단차|배리어프리|엘리베이터"),
        ("콘센트·와이파이", r"콘센트|와이파이|wi-?fi|충전|플러그"),
        ("예약 가능", r"예약"),
        ("반려동물 동반", r"반려|애견|강아지|펫"),
        ("가성비 좋은 곳", r"가성비|저렴|싼|합리적"),
        ("대형·넓은 곳", r"대형|넓은|큰 "),
        ("빠른 식사", r"빠른|빨리|간단히|속성"),
        ("웨이팅 짧은 곳", r"웨이팅|대기|줄 서"),
        ("심야 영업", r"심야|늦게까지|밤늦|야식|2[23]\s*시|자정"),
        ("주말 오전 영업", r"(?:주말|토요일|일요일)\s*오전"),
        ("브레이크타임 없음", r"브레이크\s*타임\s*없|쉬는\s*시간\s*없"),
        ("이른 아침 영업", r"이른\s*아침|아침\s*일찍|모닝"),
    ]
]
KNOWN_TOKENS: Set[str] = {t for t, _ in INTENT_RULES} | {"지하철 30분 이내"}
DYNAMIC_TOKEN = re.compile(r"^지하철 \d{1,3}분 이내$")
NEGATION = re.compile(r"^[가-힣]{0,2}\s*(지\s*않|안\s*되|안되|말고|빼고|제외|싫)")  # "주차 안 되는", "조용하지 않은", "~말고"
AREA_STOP = {"여기", "저기", "우리", "이쪽", "저쪽", "집", "회사", "학교"}
BUDGET_RE = re.compile(r"(\d+(?:\.\d+)?)\s*만\s*원?")
MINUTES_RE = re.compile(r"지하철\s*(\d+)\s*분|(\d+)\s*분\s*(?:이내|안에|안쪽|거리|정도)")
AREA_RES = [
    re.compile(r"([가-힣A-Za-z0-9]{2,12}?)\s*(?:근처|주변|부근|인근|쪽)"),
    re.compile(r"([가-힣A-Za-z0-9]{2,10})에서\s*(?:모|만나|보)"),
]


def snap_budget(won: float) -> int:
    """슬라이더 단위(5천 원, 1만~10만)에 맞춘다. 10만 원 이상은 '제한 없음'(100000)."""
    if won >= 100_000:
        return 100_000
    return max(10_000, round(won / 5_000) * 5_000)


def parse_rules(text: str) -> Dict[str, Any]:
    """규칙 기반 파서(기본값). 모델 없이도 동작하며, LLM 파서의 폴백이기도 하다."""
    t = re.sub(r"스터디\s*카페", "스터디", text)  # "스터디카페"는 카페 테마가 아니라 스터디 목적
    tokens: List[str] = []
    for token, pattern in INTENT_RULES:
        m = pattern.search(t)
        if m and not NEGATION.match(t[m.end(): m.end() + 8]):
            tokens.append(token)

    budget: Optional[int] = None
    if (bm := BUDGET_RE.search(t)):
        budget = snap_budget(float(bm.group(1)) * 10_000)

    minutes: Optional[int] = None
    if (mm := MINUTES_RE.search(t)):
        minutes = int(mm.group(1) or mm.group(2))
        tokens.append("지하철 30분 이내" if minutes == 30 else f"지하철 {minutes}분 이내")

    area: Optional[str] = None
    for rx in AREA_RES:
        if (am := rx.search(t)):
            cand = re.sub(r"(?:에서|에|의|이랑|랑|하고)$", "", am.group(1))
            area = cand if len(cand) >= 2 and cand not in AREA_STOP else None
            break
    return {"tokens": tokens, "budget": budget, "minutes": minutes, "area": area}


def parse_with_llm(text: str, vocabulary: Optional[Dict[str, List[str]]]) -> Dict[str, Any]:
    """[확장 지점] 로컬 LLM 으로 의도를 구조화한다. 아직 구현되지 않았다.

    구현 가이드
      - vLLM / llama.cpp 서버(OpenAI 호환 API)나 transformers 파이프라인 호출
      - 출력은 JSON 스키마(또는 grammar)로 강제해 {tokens, budget, minutes, area} 만 받는다
      - tokens 는 반드시 `vocabulary` 안의 문구만 고르게 프롬프트에 명시한다 (후단 sanitize_intent 가 한 번 더 걸러낸다)
      - 실패하거나 시간이 초과되면 예외를 던지면 된다 → 호출부가 parse_rules 로 대체한다
    """
    raise NotImplementedError


def sanitize_intent(raw: Dict[str, Any], vocabulary: Optional[Dict[str, List[str]]]) -> Dict[str, Any]:
    """파서(규칙/LLM)가 무엇을 돌려주든 계약에 맞는 값만 응답으로 내보낸다."""
    allowed = {t for tokens in vocabulary.values() for t in tokens} if vocabulary else KNOWN_TOKENS
    seen: Set[str] = set()
    tokens: List[str] = []
    for t in raw.get("tokens") or []:
        t = str(t)
        if t in seen or not (t in allowed or DYNAMIC_TOKEN.match(t)):
            continue
        seen.add(t)
        tokens.append(t)

    budget = raw.get("budget")
    minutes = raw.get("minutes")
    area = raw.get("area")
    return {
        "tokens": tokens,
        "budget": snap_budget(float(budget)) if isinstance(budget, (int, float)) else None,
        "minutes": int(minutes) if isinstance(minutes, (int, float)) and 0 < minutes <= 300 else None,
        "area": str(area).strip()[:20] if isinstance(area, str) and area.strip() else None,
    }


# ───────────────────────────── API 스키마 ─────────────────────────────
class STTResponse(BaseModel):
    text: str


class IntentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    lang: str = "ko"
    vocabulary: Optional[Dict[str, List[str]]] = None  # { 목적: [...], 테마: [...], ... }  (프론트 칩 문구)


class IntentResponse(BaseModel):
    tokens: List[str]
    budget: Optional[int] = None
    minutes: Optional[int] = None
    area: Optional[str] = None


# ───────────────────────────── 앱 ─────────────────────────────
@asynccontextmanager
async def lifespan(_: FastAPI):
    load_stt()  # 모델은 시작할 때 한 번만 올린다
    yield


app = FastAPI(title="모여라 AI backend", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "stt": stt.model is not None,
        "intent": True,
        "intent_backend": INTENT_BACKEND,
        "gpu": stt.gpu,  # 프론트가 "인식: AI 서버(<gpu>)" 로 표시한다. CPU 이면 빈 문자열
        "device": stt.device if stt.model is not None else "",
        "model": stt.model_name,
        "compute_type": stt.compute_type,
        "stt_error": stt.error,
    }


# 동기 def 로 두면 FastAPI 가 스레드풀에서 실행하므로 추론 중에도 이벤트 루프가 막히지 않는다
@app.post("/stt", response_model=STTResponse)
def transcribe(audio: UploadFile = File(...), lang: str = Form("ko")) -> STTResponse:
    if stt.model is None:
        raise HTTPException(status_code=503, detail="음성 인식 모델이 준비되지 않았어요.")

    data = audio.file.read(STT_MAX_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="빈 오디오예요.")
    if len(data) > STT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="오디오가 너무 길어요.")

    language = lang if re.fullmatch(r"[a-z]{2}", lang or "") else "ko"
    started = time.perf_counter()
    try:
        with stt.slots:
            segments, info = stt.model.transcribe(
                io.BytesIO(data),  # 디스크에 쓰지 않고 메모리에서 디코딩 (webm/opus, mp4/aac 등)
                language=language,
                beam_size=5,
                vad_filter=True,  # 무음 구간 제거 → 환각 방지
                vad_parameters={"min_silence_duration_ms": 300},
                condition_on_previous_text=False,
                initial_prompt=STT_HINT or None,
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()  # 제너레이터이므로 락 안에서 소비
    except Exception:
        log.exception("STT 실패 (bytes=%d)", len(data))
        raise HTTPException(status_code=422, detail="오디오를 해석하지 못했어요.")
    finally:
        del data  # 인식이 끝나면 오디오는 바로 버린다

    log.info("STT 완료: audio=%.1fs elapsed=%.2fs chars=%d", info.duration, time.perf_counter() - started, len(text))
    return STTResponse(text=text)


@app.post("/intent", response_model=IntentResponse)
def parse_intent(req: IntentRequest) -> Dict[str, Any]:
    raw: Optional[Dict[str, Any]] = None
    if INTENT_BACKEND == "llm":
        try:
            raw = parse_with_llm(req.text, req.vocabulary)
        except NotImplementedError:
            log.warning("INTENT_BACKEND=llm 이지만 parse_with_llm 이 구현되지 않아 규칙 파서를 사용해요.")
        except Exception:
            log.exception("LLM 의도 파싱 실패 → 규칙 파서로 대체")
    if raw is None:
        raw = parse_rules(req.text)
    return sanitize_intent(raw, req.vocabulary)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8000")))
