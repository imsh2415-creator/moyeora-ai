# 📍 모여라 AI

모두가 편한 약속 장소 큐레이터 — 여러 출발지와 자연어·음성 조건을 입력하면 **공평한 중간 지점**과 **조건에 맞는 주변 스팟**을 한 화면에서 추천합니다.

**Live demo:** https://moyeora-ai.vercel.app

## 주요 기능
- **공평성 점수**: 인원별 이동시간 편차로 중간 지점을 비교 (전국 거점역 55곳 + 필요 시 무게중심 지점)
- **조건 필터**: 목적·테마·분위기·시설/서비스·속성·영업시간 6개 카테고리, 칩 36개 + 모임 템플릿 6종
- **조건 반영 장소 추천**: 선택한 조건이 검색어와 점수를 직접 결정 (OpenStreetMap 실데이터), 일치 근거(✓) 표시
- **음성 입력**: 말하면 필터 칩이 자동으로 켜짐 (브라우저 음성인식 또는 GPU 서버 `faster-whisper`)
- **전국 주소·GPS**: Nominatim 지오코딩, 내 위치 버튼
- **공유**: 결과 링크 / 카카오톡 공유 텍스트
- **키 없이 동작**: 외부 API 키가 없어도 끝까지 작동. Claude API 키(선택)를 넣으면 이동시간·브리핑·유명 스팟을 AI가 분석

## 구조
| 경로 | 설명 |
|---|---|
| `index.html` `styles.css` `app.js` | 프론트엔드 (순수 JS + Leaflet, 빌드 불필요) |
| `server.py` `requirements.txt` | 선택 백엔드: FastAPI + faster-whisper (`/health` `/stt` `/intent`) |

## 실행
**프론트엔드**: `index.html`을 브라우저로 열거나 정적 서버로 서빙합니다. 마이크·GPS는 `https` 또는 `localhost`에서만 동작합니다.

**백엔드(선택)**
```bash
pip install -r requirements.txt
python server.py            # http://127.0.0.1:8000
```
브라우저 콘솔에서 서버를 연결합니다.
```js
localStorage.setItem('moyeora.backend', 'http://127.0.0.1:8000')
```
- GPU가 있으면 자동으로 CUDA(`large-v3`)를, 없으면 CPU(`small`)를 사용합니다 (`WHISPER_MODEL`, `WHISPER_DEVICE`로 변경).
- 서버가 없거나 응답이 없으면 브라우저 음성인식과 로컬 규칙 파서로 자동 대체됩니다.

## 한계
- 이동시간은 직선거리 기반 **추정치**입니다 (실제 환승·경로와 다를 수 있음).
- "인기순"은 리뷰가 아니라 OSM 정보량 기반 추정입니다.
- OpenStreetMap에 등록된 장소만 찾을 수 있어 지역에 따라 결과가 적을 수 있습니다.

## 보안·개인정보
- Claude API 키는 브라우저 탭(`sessionStorage`)에만 저장되고, Anthropic API 호출 외에는 어디에도 전송되지 않습니다. 다만 브라우저에서 직접 호출하는 구조라 키가 노출될 수 있으니 개인 테스트용으로만 쓰고, 실서비스에서는 서버 프록시를 거치세요.
- 음성은 저장하지 않습니다 (서버는 메모리에서만 처리 후 폐기).
