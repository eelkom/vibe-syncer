# vibe-syncer 1단계 측정 도구 (#34)

병합 전 커밋과 기준 main `b86324b`를 동일한 실행기로 비교한다. 앱 소스는 수정하지 않고 `git archive`로 푼 프론트 빌드와 백엔드를 사용한다. 본 실행은 로컬에서 명시적으로 시작한다. 이 도구의 개발 중 실행한 것은 단위 테스트, 서버 확인, 재연결 **봇 스모크**뿐이며 브라우저 시나리오와 본 측정은 실행하지 않았다.

## 전제 조건과 격리

- 저장소 루트에서 실행한다. Node 22 이상, npm, uv, Python 3.11, PostgreSQL 도구(`pg_config`, `initdb`, `pg_ctl`), `/opt/homebrew/bin/ffmpeg`(VP8/libvpx·Opus/libopus 지원)와 `/opt/homebrew/bin/ffprobe`, Chromium 실행 가능한 환경이 필요하다. ffmpeg가 없으면 명확한 오류로 중단한다.
- DB는 **127.0.0.1:55432**, 사용자 `vibe`, 비밀번호 없음, `CREATEDB` 권한. 5432나 운영 DB는 사용하지 않는다. 실행기는 다른 DB 호스트·포트를 거부하고 `loadtest_*` DB만 만든다. 기존 동명 DB가 있으면 삭제하지 않고 실패한다.
- 포트: API/WS `18000`, 프론트 `15173`, 음원 `15174`. 전부 127.0.0.1에만 바인딩한다. 같은 도구의 동시 실행은 `.logs/stage1.lock`으로 거부한다. 비정상 종료 후 잠금이 남으면 실행 중 프로세스가 없음을 확인한 다음 해당 잠금 파일만 제거한다.
- 현재 환경에 이미 떠 있는 전용 DB와 `loadtest/.pg/`, `.pg.log`는 그대로 사용한다. **이 환경에서는 db.sh를 실행하지 않는다.** 아래 DB 명령은 다른 사람이 새 환경을 만들 때 사용한다.
- Python 서버는 dotenv 로딩을 끄고 GEMINI/GOOGLE 키를 지우며 AI 환영 함수는 고정 문자열, DJ 함수는 예외로 치환한다. 치환 후 `app.main`을 import한다. 외부 소켓 연결도 거부한다. 미디어는 로컬 WebM 영상 파일이며 Gemini/YouTube API와 운영 서버를 사용하지 않는다.
- 브라우저에 `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`을 고정 적용한다. 해제 옵션은 없다. 일반 HTTP와 WebSocket은 Playwright Node 프로세스를 거치지 않는다. `blocked_external_requests`는 `page.on('request')`에서 센 127.0.0.1 이외 요청 수와 `page.on('websocket')`에서 센 외부 연결 수의 합이다. 외부 폰트 차단 오류는 발생할 수 있다. `history_race`의 `/chats`만 지연 주입을 위해 `page.route`로 가로챈다.

## 환경 변수와 설치

캐시는 저장소 안에 둔다. 아래 명령은 모두 저장소 루트 기준이다.

```bash
export npm_config_cache="$PWD/loadtest/.npm-cache"
export UV_CACHE_DIR="$PWD/loadtest/.uv-cache"
export UV_PYTHON_INSTALL_DIR="$PWD/loadtest/.uv-python"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/loadtest/.pw-browsers"
npm ci --prefix loadtest
(cd loadtest && npx --no-install playwright install chromium)
```

마지막 Chromium 설치와 실제 브라우저 실행은 샌드박스 밖에서 한다. 패키지 다운로드 외 네트워크 사용은 필요 없다. 준비 스크립트와 브라우저 모듈도 위 캐시 경로를 고정한다.

다른 사람의 새 전용 DB 환경:

```bash
loadtest/scripts/db.sh initdb
loadtest/scripts/db.sh start
# 모든 측정이 끝난 뒤에만:
loadtest/scripts/db.sh stop
```

`db.sh`는 `LC_ALL=C`, `PGDATA=loadtest/.pg`, 포트 55432, listen 127.0.0.1, `max_connections=300`을 사용한다. `PGBIN`을 설정하면 PostgreSQL 실행 파일 디렉터리를 지정할 수 있다. 기존 PGDATA에서 initdb를 거부한다.

전체 비교 커밋 준비:

```bash
for sha in 8003014 e75a31c b86324b e7904b9 32cdc26 08eb0e5 1b2e6c4 ea2acea a086001; do
  loadtest/scripts/prepare_commit.sh "$sha" || break
done
```

각 커밋은 `.baselines/<7자리sha>`에 `git archive | tar`로 추출한다. 추출 대상에 `.archive-sha`를 기록하며, 불완전한 추출은 실패한다. worktree를 만들지 않는다. 커밋별 `npm ci` 후 `npx vite build`를 실행하고 tsc는 실행하지 않는다. 프론트 빌드는 다음 값을 사용한다.

| 변수 | 고정값 | 모든 9개 커밋의 근거 |
|---|---|---|
| `VITE_API_BASE_URL` | `http://127.0.0.1:18000` | `frontend/src/api/apiClient.ts:6` |
| `VITE_WS_BASE_URL` | `ws://127.0.0.1:18000/ws` | `frontend/src/hooks/useWebSocket.ts`의 `WS_BASE_URL` 선언 |

이름이 달라 별도 처리한 커밋은 없다. Python은 `backend/runtime.txt`의 3.11 계열로 `.venv` 하나를 만들고 현재 `backend/requirements.txt`를 공유한다. 앱의 requirements는 버전이 고정되어 있지 않으므로 실제 설치 목록을 `.logs/python-freeze.txt`와 env JSON에 기록한다. 옛 커밋이 공유 의존성으로 실행되지 않으면 패치하거나 의존성을 바꾸지 말고 중단한다.

## 실행 명령

브라우저 없는 검증:

```bash
node --test loadtest/test
find loadtest/lib loadtest/scenarios loadtest/test -type f \( -name '*.mjs' -o -name '*.js' \) -exec node --check {} \;
node --check loadtest/run_stage1.mjs
node --check loadtest/summarize.mjs
python3 -m py_compile loadtest/server/run_server.py
bash -n loadtest/scripts/db.sh loadtest/scripts/prepare_commit.sh
```

단위 테스트는 중앙값, nearest-rank p75/p95, 보간·paused 제외, 2초 연속 동기화, 1초 구간 최고치, 두 재연결 공식 범위, 정확한 마커 집계, summarize의 null 처리와 주입 무효 회차 집계를 검증한다.

봇만 스모크(브라우저를 실행하지 않음; `b86324b` 준비 필요):

```bash
node loadtest/run_stage1.mjs --scenario reconnect --condition exponential --smoke
node loadtest/run_stage1.mjs --scenario reconnect --condition full-jitter --smoke
```

Claude가 샌드박스 밖에서 실행할 전체 스모크(모든 커밋 준비 및 Chromium 설치 후):

```bash
node loadtest/run_stage1.mjs --smoke
```

본 실행은 위 브라우저 스모크 검토 후 별도로 실행한다.

```bash
node loadtest/run_stage1.mjs
node loadtest/run_stage1.mjs --scenario late_join --runs 5
node loadtest/summarize.mjs
```

`--scenario`는 `late_join`, `message_burst`, `history_race`, `reconnect`, `autoplay`, `all`을 받는다. `--condition`은 정의된 조건 하나만 선택한다(봇만 실행할 때 유용). 조건의 수치나 타이밍을 바꾸는 옵션은 없다. 기본 5회, 재연결 `browser-10`만 기본 3회. `--runs`는 회차 수, `--smoke`는 항상 1회다. 이미 있는 결과는 성공/실패와 무관하게 건너뛴다. 명시적 `--force`는 기존 원본을 `run-N.previous-<timestamp>.json`으로 보존한 뒤 다시 쓴다. 요약은 `run-N.json`만 읽는다. 실패하면 원본을 저장하고 배치를 중단한다. 자동 재실행이나 좋은 결과 선택은 없다.

## 비교 대상과 고정 조건

| 시나리오 | 비교 커밋 | 조건 |
|---|---|---|
| late_join (#19, #29) | `8003014`, `e75a31c`, `b86324b` | default |
| message_burst (#13) | `e7904b9`, `b86324b` | 50, 200, 1000 |
| history_race (#20, #16) | `32cdc26`, `08eb0e5`, `b86324b` | default |
| reconnect 봇 (#12) | `1b2e6c4`, `b86324b`의 공식 | exponential, full-jitter; 서버는 모두 b86324b |
| reconnect 브라우저 | `1b2e6c4`, `b86324b` | browser-10; 프론트와 서버 모두 해당 커밋 |
| autoplay (#14, #15) | `ea2acea`, `a086001`, `b86324b` | muted-allowed, all-blocked |

- 회차마다 `loadtest_<scenario>_<sha>_<n>` DB를 새로 만들고 서버를 새 프로세스로 시작한다. 방·호스트·게스트는 해당 서버의 `POST /rooms/`, `POST /rooms/join`으로 생성한다. 곡만 `queue_items`에 SQL로 넣는다. `platform='Local'`은 모든 비교 커밋의 `backend/app/schemas/schemas.py`에서 `str`, SQL 모델에서 `String`으로 허용된다.
- `.media/tone.webm`은 ffmpeg로 생성하는 600초 영상이다. VP8 영상(16x16, 1fps, 검은 단색)과 Opus 오디오(440Hz 사인파, 48kHz 모노)를 담는다. `music_url`은 `http://127.0.0.1:15174/tone.webm`이며 Range 지원 서버가 `video/webm`으로 제공한다. 프론트 서버는 SPA 폴백을 제공한다. 미디어 파일은 커밋하지 않는다. 브라우저 없이 생성·검증하려면 다음을 실행한다.

  ```bash
  node --input-type=module -e "import { tone } from './loadtest/lib/static-server.mjs'; console.log(await tone());"
  /opt/homebrew/bin/ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,r_frame_rate:format=duration -of json loadtest/.media/tone.webm
  ```
- late_join: 브라우저 인스턴스를 호스트/게스트로 분리한다. 호스트는 자동재생 허용, 게스트는 사용자 활성화 필요 정책. 호스트 재생을 확인한 뒤 UI 일시정지 → 300ms → UI 재생, 두 `sync` 전송 프레임을 확인한다. 30초 후 게스트 goto 직전 T0, 25초 관찰한다. 스모크는 5초 대기/8초 관찰하므로 10초·20초 오차는 null이다.
- message_burst: 게스트 브라우저의 채팅 조회 응답 완료와 로딩 UI 제거를 확인한다. Node 발신자 1개는 N개를 **대기 없이 연속 전송**, 대조군 Node 수신자 1개가 모두 받거나 120초 후, DOM이 3초 조용해지면 채팅 영역만 집계한다. 마커는 공백으로 나뉜 정확 토큰으로 세며 초과 등장 횟수를 duplicates로 기록한다. 스모크는 N=50만 사용한다.
- history_race는 **지연 주입**이다. GET chats를 서버 전송 전에 보류하고 게스트 WebSocket 첫 수신을 확인한다. A 25개를 20ms 간격으로 보내 마지막 프레임을 확인한다. 조회를 서버에 보내 응답을 보류하고 A 포함/B 미포함을 확인한다. B 25개를 같은 간격으로 보내 마지막 프레임 확인 후 응답을 전달하고 12초 대기한다. OPTIONS는 그대로 통과한다. 두 번째부터의 GET은 `route.fallback()`으로 통과시키고 `extra_history_gets`로 세며 오류로 처리하지 않는다. 스모크는 각 5개/3초다. 조회 보류 중 WS 수신이 불가능하면 timeout과 순서 오류를 저장하고 중단한다.
- reconnect 봇: 200개를 50ms마다 입장시키고 모두 연결된 뒤 10초 안정화한다. SIGTERM 후 종료를 확인하고 **고정 3초 뒤** 서버를 새로 시작한다. 전원 연결/포기 또는 장애 시작부터 120초까지 기록한다. 스모크는 10개/2초 안정화. 앱과 동일하게 onopen에서 카운터를 0으로 초기화하며 최대 재시도는 5회다. exponential은 `min(30000,1000*2^attempt)`, full-jitter는 `random()*min(30000,1000*2^attempt)`다. 근거는 `1b2e6c4:useWebSocket.ts:33,61,111-123`, `b86324b:useWebSocket.ts:32-42,95,112,176-190`. 1초 구간은 시도는 장애 시작, open은 서버 listen 기준의 고정 구간이다. 서버 listen 시각은 uvicorn이 bind를 마친 직후 Python 실행기가 기록한다. RSS는 측정하지 않는다.
- reconnect 브라우저: 해당 커밋 프론트/서버에서 10개 컨텍스트를 연결하고 같은 재시작을 한다. `page.on('websocket')` 시각과 첫 재시도 분포를 기록한다. 스모크는 2개 컨텍스트. 브라우저 인스턴스는 공유하되 컨텍스트는 분리한다.
- autoplay: 호스트는 late_join과 같은 UI 경로로 서버 재생 상태를 남기고 5초 대기한다. 게스트는 두 조건 모두 사용자 활성화 필요 정책. `all-blocked`는 init script로 사용자 활성화 전 play를 NotAllowedError로 거부하고, 미디어 요소의 `setAttribute('autoplay', ...)`와 `autoplay` setter를 무시하는 **주입**이며 저전력 모드 등을 모사한다. 활성화 뒤에는 원래 동작으로 전달하며 도구가 대신 play를 호출하지 않는다. 세 경로의 차단 횟수 합계를 `window.__blockedPlay`와 회차 지표 `blocked_play_calls`에 기록한다. `injection_effective`는 첫 실제 클릭 전(클릭이 없으면 전체 관찰 구간)에 재생 중 ct가 0.2초 이상 증가한 샘플이 없으면 true다. `muted-allowed`에서는 두 지표 모두 null이다. 요약 표는 `injection_effective`가 명시적으로 false인 회차 수를 표시한다. 30초까지 소리가 없으면 failed. 들리기 시작이 마감 직전이면 오차 측정에 필요한 2초만 추가 관찰하며 30초 성공 마감은 유지한다. 스모크도 환경별 1회/30초다.

## 커밋별 UI와 sessionStorage 근거

모든 9개 커밋의 `frontend/src/contexts/UserContext.tsx:16-18`은 `sessionStorage['user']` JSON을 읽고 `types/user.ts:1-6`은 `{userId, nickname, isHost, token}`을 정의한다. REST 응답에서 이 형태를 만든 뒤 `/room/<room_code>`로 바로 이동한다(`routes/routePath.ts:3`). 커밋별 사용자 형태 차이는 없다.

선택자는 `frontend/src/page/MusicRoom/components/MusicPlayer.tsx`를 각 커밋에서 확인했다.

| 커밋 | 동기화 | 소리 켜기 | 호스트 재생/일시정지 |
|---|---|---|---|
| 8003014, e7904b9, 32cdc26, 1b2e6c4, ea2acea | `button.animate-pulse` (needsSync) | 없음 | `button.h-14` |
| e75a31c, 08eb0e5, a086001, b86324b | `button.animate-pulse` (needsSync) | 정확한 텍스트 `탭하여 소리 켜기` | `button.h-14` |

예: `8003014`의 120-135행, `b86324b`의 131-146행은 동기화/중앙 버튼, `b86324b`의 160-166행은 소리 켜기 버튼이다. 없는 버튼을 대체하거나 앱을 패치하지 않는다. 채팅 입력 `input[placeholder="Message..."]`, 채팅 영역 `div.scrollbar-hide.overflow-y-auto` 및 로딩 중 직계 `div.h-full`은 모든 커밋의 `components/ChatBoard.tsx`에 공통이다.

스크립트 사용자는 250ms마다 보이는 동기화/소리 켜기 버튼을 찾고 최초 확인 1000ms 후 실제 Playwright 클릭을 한다. 총 시도 상한은 5회이며 최초 확인·시도·실제 trusted click 시각과 성공 여부를 기록한다. **사용자 반응 시간 1000ms가 측정값에 포함된다.** 동기화 버튼을 우선하며 더 이상 보이지 않으면 예약을 취소한다.

## 원본, 요약과 계측 정의

본 실행 원본: `results/stage1/<scenario>/<shortsha>/<condition>/run-N.json`, 환경: `results/stage1/env-<timestamp>.json`. 요약은 `results/stage1/SUMMARY.md`. 스모크는 동일 구조로 `results/smoke/`에 기록하고 git에서 제외한다. 이 변경에는 본 측정 결과를 포함하지 않는다.

각 run은 시나리오·공식/프론트 커밋·서버 커밋·조건·회차·시작/종료 시각·원시 지표·차단 요청 수·오류 목록·`ok`를 가진다. `ok`는 스크립트가 끝까지 실행됐는지이며, autoplay의 `failed`나 null 동기화 결과와 별개다. 브라우저 실패 도중에도 가능한 샘플/프레임/콘솔은 cleanup 전에 `browser_artifacts`에 보존한다. 봇은 개별 시도/open/close 코드·지연·수신 건수를 남긴다.

환경 JSON은 Node, Python, 실제 launch에서 얻은 Chromium 버전, CPU 모델·코어 수, 메모리, OS, 전용 Postgres 버전, git HEAD와 기준 main, 실행 인자, 시작 부하 평균, Python 의존성을 기록한다. 봇만 실행한 환경의 실제 Chromium 버전은 null이고 Playwright manifest의 예상 버전은 별도 필드다. 브라우저를 실행하지 않고 버전을 만들어 쓰지 않는다.

브라우저 init script는 100ms마다 첫 `audio,video`의 `{t: Date.now(), ct, paused, muted, volume}` 또는 `{t, none:true}`를 수집한다. 게스트 샘플 시각에서 호스트 위치를 선형 보간해 절대 오차(ms)를 구한다. 게스트와 보간 양 끝의 호스트가 모두 재생 중이어야 유효하다. 외삽하지 않는다. 250ms를 넘는 관측 공백·paused·미디어 없음은 2초 연속 동기화 판정을 끊는다. `sync_time_ms`는 오차 500ms 미만이 2초 유지되는 구간의 시작 시각이다. 지정 시점 오차는 ±200ms 안의 가장 가까운 샘플이며 없으면 null이다.

late_join의 마지막 10초 오차 p50/p75/p95는 유효 샘플에서 계산한다. autoplay는 재생 중인 샘플에서 ct가 0.2초 이상 증가한 첫 확인 시각을 사용하며 audible은 추가로 muted=false, volume>0이어야 한다. 모든 회차별 값은 그대로 저장하고 요약에서 회차 중앙값과 nearest-rank p75/p95를 구한다. 회차가 5개면 nearest-rank p95는 최댓값과 같다. null/미기록은 0으로 바꾸지 않으며 결측 회차 수를 표시한다. 실패한 회차도 집계에서 없애지 않는다.

## 브라우저 스모크 확인 항목과 한계

- `.logs/server-*.log` 시작에 `STAGE1 AI replacement applied: get_ai_welcome_message; client=None` 및 DJ 치환 로그가 있는지 확인한다. 함수가 없는 커밋은 `replacement absent` 로그를 확인한다. AI 치환은 단위 테스트 대신 이 시작 로그로 확인한다.
- 호스트 UI pause/play의 실제 `sync` 전송, 게스트 `sync` 수신과 queue 응답, 클릭의 trusted 시각, 외부 요청 차단 수를 원본에서 확인한다.
- history_race 원본의 A 수신 → 응답 보류 → B 수신 → 전달 순서와 스냅샷을 확인한다. 순서를 충족하지 못하면 결과를 정상 측정으로 해석하지 않는다.
- 브라우저 SIGTRAP 제약 때문에 이 샌드박스에서는 브라우저 시나리오를 실행하지 않았다. Claude가 샌드박스 밖에서 스모크 로그를 검토해야 한다.
- 봇은 한 Node 프로세스의 이벤트 루프·네트워크·CPU 스케줄링 한계가 포함된다. 실제 사용자 200명의 브라우저 부하를 재현하지 않는다. 소수 실제 브라우저 검증은 공식 동작 확인용이다.
- 로컬 영상 파일과 동일 머신 시계의 결과다. 실제 서비스 경로는 YouTube iframe이지만 시험은 로컬 영상 파일이므로 YouTube의 버퍼링과 `handleUnmute`의 YouTube 분기는 재지 않는다. 원격망/운영 부하, 실제 저전력 모드, 확성기에서 소리가 나는지는 재현하지 않는다. audible은 미디어 요소 상태를 기준으로 한다. 무음 허용 여부는 Chromium 정책에도 좌우된다.
- 스모크 수치는 작은 크기의 도구 검증 결과이며 성능 결론에 사용하지 않는다. 로그·캐시·음원·아카이브·전용 DB 데이터는 git에서 제외한다.
