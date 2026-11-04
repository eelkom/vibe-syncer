# vibe-syncer 1단계 측정 도구 (#34)

병합 전 커밋과 기준 main `b86324b`를 동일한 실행기로 비교한다. 앱 소스는 수정하지 않고 `git archive`로 푼 프론트 빌드와 백엔드를 사용한다. 본 실행은 로컬에서 명시적으로 시작한다. 도구 검증은 단위 테스트·서버 확인·스모크로 수행하고, 본 측정은 검증을 마친 뒤 별도로 실행한다.

## 전제 조건과 격리

- 저장소 루트에서 실행한다. Node 22 이상, npm, uv, Python 3.11, PostgreSQL 도구(`pg_config`, `initdb`, `pg_ctl`), `/opt/homebrew/bin/ffmpeg`(VP8/libvpx·Opus/libopus 지원)와 `/opt/homebrew/bin/ffprobe`, Chromium 실행 가능한 환경이 필요하다. ffmpeg가 없으면 명확한 오류로 중단한다.
- DB는 **127.0.0.1:55432**, 사용자 `vibe`, 비밀번호 없음, `CREATEDB` 권한. 5432나 운영 DB는 사용하지 않는다. 실행기는 다른 DB 호스트·포트를 거부하고 `loadtest_*` DB만 만든다. 기존 동명 DB가 있으면 삭제하지 않고 실패한다.
- 전용 DB 시간대는 운영과 같은 UTC로 고정한다. `+09:00` 응답은 프론트 `RoomInfosResponseSchema.created_at`의 `z.string().datetime()` 검증을 통과하지 못하므로, 클러스터 시작 옵션과 각 DB의 `ALTER DATABASE ... SET timezone TO 'UTC'`를 함께 적용한다.
- 포트: API/WS `18000`, 프론트 `15173`, 음원 `15174`. 전부 127.0.0.1에만 바인딩한다. 같은 도구의 동시 실행은 `.logs/stage1.lock`으로 거부한다. 비정상 종료 후 잠금이 남으면 실행 중 프로세스가 없음을 확인한 다음 해당 잠금 파일만 제거한다.
- 전용 DB가 이미 실행 중이면 접속 정보와 설정을 확인한 뒤 재사용한다. 기존 `loadtest/.pg/`, `.pg.log`를 초기화하거나 삭제하지 않는다. 아래 initdb 명령은 새 전용 클러스터를 만들 때만 사용한다.
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

Chromium 설치와 실제 브라우저 실행은 브라우저 프로세스 실행이 허용되는 환경에서 한다. 패키지 다운로드 외 네트워크 사용은 필요 없다. 준비 스크립트와 브라우저 모듈도 위 캐시 경로를 고정한다.

새 전용 DB 환경 초기화:

```bash
loadtest/scripts/db.sh initdb
loadtest/scripts/db.sh start
# 모든 측정이 끝난 뒤에만:
loadtest/scripts/db.sh stop
```

`db.sh`는 `LC_ALL=C`, `PGDATA=loadtest/.pg`, 포트 55432, listen 127.0.0.1, `max_connections=300`, `timezone=UTC`를 사용한다. `PGBIN`을 설정하면 PostgreSQL 실행 파일 디렉터리를 지정할 수 있다. 기존 PGDATA에서 initdb를 거부한다.

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

이름이 달라 별도 처리한 커밋은 없다. Python은 `backend/runtime.txt`의 3.11 계열로 `.venv` 하나를 만들고 `loadtest/requirements.lock`으로 설치한다. 이 lock은 측정에 사용한 `.logs/python-freeze.txt`를 그대로 고정한 55개 패키지 목록이다. 작업 트리의 `backend/requirements.txt`는 읽지 않는다. 설치 후 freeze가 lock과 동일한지 확인하고 실제 설치 목록을 `.logs/python-freeze.txt`와 env JSON에 기록한다. 옛 커밋이 공유 의존성으로 실행되지 않으면 패치하거나 의존성을 바꾸지 말고 중단한다.

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

단위 테스트는 중앙값, nearest-rank p75/p95, 보간·paused 제외, 2초 연속 동기화, 1초 구간 최고치, 두 재연결 공식 범위, 정확한 마커 집계, 재생 시작 후 일시정지 전환, 500ms/2000ms 동기화 임계값, 클릭 전 활성화 오염, 클릭 기록 대조, WebSocket 실패 시도·포기 판정, summarize의 무효 회차 집계를 검증한다. 가짜 페이지와 JS VM으로 버튼 감지·좌표 클릭·WebSocket 래퍼도 검증하며 Chromium은 실행하지 않는다.

봇만 스모크(브라우저를 실행하지 않음; `b86324b` 준비 필요):

```bash
node loadtest/run_stage1.mjs --scenario reconnect --condition exponential-14 --smoke
node loadtest/run_stage1.mjs --scenario reconnect --condition full-jitter-14 --smoke
node loadtest/run_stage1.mjs --smoke --force --scenario reconnect --condition full-jitter-200-pool
```

전체 브라우저 스모크(모든 커밋 준비 및 Chromium 설치 후):

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
| reconnect 봇 (#12) | `1b2e6c4` 공식 | exponential-14: 14개, b86324b 풀 수정 없음 |
| reconnect 봇 (#12) | `b86324b` 공식 | full-jitter-14: 14개, b86324b 풀 수정 없음 |
| reconnect 봇 (#12) | `1b2e6c4` 공식 | exponential-200-pool: 200개, b86324b 측정용 풀 250 |
| reconnect 봇 (#12) | `b86324b` 공식 | full-jitter-200-pool: 200개, b86324b 측정용 풀 250 |
| reconnect 브라우저 | `1b2e6c4`, `b86324b` | browser-10; 프론트와 서버 모두 해당 커밋 |
| autoplay (#14, #15) | `ea2acea`, `a086001`, `b86324b` | muted-allowed, all-blocked, silent-blocked |

- 회차마다 `loadtest_<scenario>_<sha>_<n>` DB를 새로 만들고 서버를 새 프로세스로 시작한다. 방·호스트·게스트는 해당 서버의 `POST /rooms/`, `POST /rooms/join`으로 생성한다. 곡만 `queue_items`에 SQL로 넣는다. `platform='Local'`은 모든 비교 커밋의 `backend/app/schemas/schemas.py`에서 `str`, SQL 모델에서 `String`으로 허용된다.
- `.media/tone.webm`은 ffmpeg로 생성하는 600초 영상이다. VP8 영상(16x16, 1fps, 검은 단색)과 Opus 오디오(440Hz 사인파, 48kHz 모노)를 담는다. `music_url`은 `http://127.0.0.1:15174/tone.webm`이며 Range 지원 서버가 `video/webm`으로 제공한다. 프론트 서버는 SPA 폴백을 제공한다. 미디어 파일은 커밋하지 않는다. 브라우저 없이 생성·검증하려면 다음을 실행한다.

  ```bash
  node --input-type=module -e "import { tone } from './loadtest/lib/static-server.mjs'; console.log(await tone());"
  /opt/homebrew/bin/ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,r_frame_rate:format=duration -of json loadtest/.media/tone.webm
  ```
- late_join: 브라우저 인스턴스를 호스트/게스트로 분리한다. 호스트는 자동재생 허용, 게스트는 사용자 활성화 필요 정책. 호스트 재생을 확인한 뒤 UI 일시정지 → 300ms → UI 재생, 두 `sync` 전송 프레임을 확인한다. 30초 후 게스트 goto 직전 T0, 25초 관찰한다. 스모크는 5초 대기/8초 관찰하므로 10초·20초 오차는 null이다.
- message_burst: 게스트 브라우저의 채팅 조회 응답 완료와 로딩 UI 제거를 확인한다. Node 발신자 1개는 N개를 **대기 없이 연속 전송**, 대조군 Node 수신자 1개가 모두 받거나 120초 후, DOM이 3초 조용해지면 채팅 영역만 집계한다. 마커는 공백으로 나뉜 정확 토큰으로 세며 초과 등장 횟수를 duplicates로 기록한다. 스모크는 N=50만 사용한다.
- history_race는 **지연 주입**이다. GET chats를 서버 전송 전에 보류하고 게스트 WebSocket 첫 수신을 확인한다. A 25개를 20ms 간격으로 보내 마지막 프레임을 확인한다. 조회를 서버에 보내 응답을 보류하고 A 포함/B 미포함을 확인한다. B 25개를 같은 간격으로 보내 마지막 프레임 확인 후 응답을 전달하고 12초 대기한다. OPTIONS는 그대로 통과한다. 두 번째부터의 GET은 `route.fallback()`으로 통과시키고 `extra_history_gets`로 세며 오류로 처리하지 않는다. 스모크는 각 5개/3초다. 조회 보류 중 WS 수신이 불가능하면 timeout과 순서 오류를 저장하고 중단한다.
- reconnect 봇: 조건별 14개 또는 200개를 50ms마다 입장시키고 모두 연결된 뒤 10초 안정화한다. SIGTERM 후 종료를 확인하고(10초 내 종료되지 않으면 SIGKILL) **고정 3초 뒤** 서버를 새로 시작한다. 전원 연결/포기 또는 장애 시작부터 120초까지 기록한다. 스모크는 모든 봇 조건에서 10개/2초 안정화이며 풀 인자는 본 실행과 동일하다. 네 조건 모두 기본 5회다. 조건 이름 접두사로 지연 공식을 고른다. 앱과 동일하게 onopen에서 카운터를 0으로 초기화하며 최대 재시도는 5회다. exponential은 `min(30000,1000*2^attempt)`, full-jitter는 `random()*min(30000,1000*2^attempt)`다. 근거는 `1b2e6c4:useWebSocket.ts:33,61,111-123`, `b86324b:useWebSocket.ts:32-42,95,112,176-190`. 기존 `peak_*_per_s`의 고정 1초 구간은 시도는 장애 시작, open은 서버 listen 기준이다. 추가 지표 `peak_attempts_rolling_1s`, `peak_opens_rolling_1s`는 각각 outage 이후 시도와 listen 이후 open을 정렬해 양 끝 시각 차이가 1000ms 미만인 이동 구간의 최고치를 센다. 고정 구간 지표도 그대로 보존한다. 서버 listen 시각은 uvicorn이 bind를 마친 직후 Python 실행기가 기록한다. RSS는 측정하지 않는다.
- reconnect 브라우저: 해당 커밋 프론트/서버에서 10개 컨텍스트를 연결하고 같은 재시작을 한다. init script가 네이티브 `window.WebSocket` 생성자를 Proxy로 감싸 생성·open·close 시각과 close code를 `window.__wsLog`에 기록한다. `new`, 정적 상수, `instanceof`와 연결 동작은 유지한다. 실패한 연결도 생성 시각으로 남으며 `page.on('websocket')`은 프레임 관찰에만 사용한다. 1초 간격으로 로그를 읽고 전원 재연결 또는 포기까지, 최대 120초 관찰한다. `tabs_reconnected`는 listen 이후 open이 있는 탭 수, `tabs_gave_up`은 outage 이후 생성 시도가 5개이고 마지막 close 후 1초 동안 이후 open이 없는 탭 수다. `attempts_per_tab`은 탭 순서대로 outage 이후 생성 시도 수를 담는다. `first_retry_range_ms`·`first_retry_stddev_ms`는 outage 이후 첫 생성 시각의 분포다. 스모크는 2개 컨텍스트. 브라우저 인스턴스는 공유하되 컨텍스트는 분리한다.
- autoplay: 호스트는 late_join과 같은 UI 경로로 서버 재생 상태를 남기고 5초 대기한다. 게스트는 세 조건 모두 사용자 활성화 필요 정책. `all-blocked`는 사용자 활성화 전 play를 즉시 NotAllowedError로 거부하는 **주입**이다. `silent-blocked`는 play가 재생을 시작하지 않고 영원히 끝나지 않는 Promise를 반환하는 **주입**으로, reject 없이 재생이 시작되지 않을 때의 앱 2초 시간 초과 경로를 관찰한다. 두 차단 조건 모두 미디어 요소의 `setAttribute('autoplay', ...)`와 `autoplay` setter를 무시한다. 활성화 뒤에는 원래 동작으로 전달하며 도구가 대신 play를 호출하지 않는다. 세 경로의 차단 횟수 합계를 `window.__blockedPlay`와 회차 지표 `blocked_play_calls`에 기록한다. `injection_effective`는 첫 실제 클릭 전(클릭이 없으면 전체 관찰 구간)에 재생 중 ct가 0.2초 이상 증가한 샘플이 없으면 true다. `muted-allowed`에서는 두 지표 모두 null이다. 요약 표는 `injection_effective`가 명시적으로 false인 회차 수를 표시하고 해당 회차를 중앙값·p75·p95에서 제외한다. 30초까지 소리가 없으면 failed. 게스트 평가 없이 들림 2초 뒤 오차를 확보하기 위해 30초에 클릭을 종료하고 32.2초까지 고정으로 관찰한 뒤 데이터를 읽는다. 성공 판정 마감은 30초 그대로다. 스모크도 환경별 1회이며 같은 관찰 시간을 쓴다.

`*-200-pool` 조건만 서버 실행기에 `--measurement-pool-size 250`을 전달한다. app을 import하기 전에 `sqlalchemy.create_engine`을 감싸 `pool_size=250, max_overflow=0`을 적용하며, 재시작에도 같은 인자를 쓴다. 앱 소스는 수정하지 않는다. 인자가 없으면 엔진 생성 동작은 그대로이며 시작 로그에 `application defaults (no override)`, 인자가 있으면 `pool_size=250 max_overflow=0`이 남는다. 250은 전용 Postgres의 `max_connections=300`보다 작다. 실행기 인자는 1~300만 받으며 측정 계획에서는 250으로 고정한다.

기존 실패 원본 `results/stage1/reconnect/1b2e6c4/exponential/run-1.json`은 보존한다. 새 계획은 옛 `exponential`, `full-jitter` 경로를 쓰지 않는다. summarize는 옛 실패 회차도 그대로 표시하고, 기존 봇 지표 `gave_up`도 계속 요약 표에 표시한다.

## 커밋별 UI와 sessionStorage 근거

모든 9개 커밋의 `frontend/src/contexts/UserContext.tsx:16-18`은 `sessionStorage['user']` JSON을 읽고 `types/user.ts:1-6`은 `{userId, nickname, isHost, token}`을 정의한다. REST 응답에서 이 형태를 만든 뒤 `/room/<room_code>`로 바로 이동한다(`routes/routePath.ts:3`). 커밋별 사용자 형태 차이는 없다.

선택자는 `frontend/src/page/MusicRoom/components/MusicPlayer.tsx`를 각 커밋에서 확인했다.

| 커밋 | 동기화 | 소리 켜기 | 호스트 재생/일시정지 |
|---|---|---|---|
| 8003014, e7904b9, 32cdc26, 1b2e6c4, ea2acea | `button.animate-pulse` (needsSync) | 없음 | `button.h-14` |
| e75a31c, 08eb0e5, a086001, b86324b | `button.animate-pulse` (needsSync) | 정확한 텍스트 `탭하여 소리 켜기` | `button.h-14` |

예: `8003014`의 120-135행, `b86324b`의 131-146행은 동기화/중앙 버튼, `b86324b`의 160-166행은 소리 켜기 버튼이다. 없는 버튼을 대체하거나 앱을 패치하지 않는다. 채팅 입력은 `input[placeholder="Message..."]`를 사용하며, 채팅 영역은 `div:has(> div > h2:text-is("Chat")) > div.scrollbar-hide.overflow-y-auto`로 Chat 제목이 있는 카드 안에서만 선택한다. `e7904b9`·`32cdc26`의 `components/ChatBoard.tsx:46-60`, `08eb0e5:45-59`, `b86324b:47-61` 모두 카드의 직계 헤더 div 안에 h2 Chat, 그 형제로 스크롤 div가 있는 동일 구조다. 대기열의 스크롤 영역은 선택하지 않는다. 로딩 중 직계 `div.h-full`은 기존과 같다.

버튼 감지는 init script의 250ms 타이머가 수행한다. 보이는 동기화/소리 켜기 버튼의 종류와 중심 좌표가 달라질 때 `console.debug('__stage1_button', JSON.stringify(...))`로 내보낸다. Node는 콘솔 메시지의 `msg.text()`만 읽고 최초 확인 1000ms 뒤 최신 좌표에 `page.mouse.click(x,y)`를 보낸다. 총 시도 상한은 5회다. 감지를 위한 Node의 locator/evaluate와 exposeBinding/exposeFunction은 사용하지 않는다. 실제 클릭 시각·종류는 기존 trusted click 캡처 기록을 측정 종료 후 읽고 각 입력 시도의 시간 구간·종류와 대조해 성공 여부를 판단한다. **사용자 반응 시간 1000ms가 측정값에 포함된다.** 동기화 버튼을 우선하며 더 이상 보이지 않으면 예약을 취소한다.

## 원본, 요약과 계측 정의

본 실행 원본: `results/stage1/<scenario>/<shortsha>/<condition>/run-N.json`, 환경: `results/stage1/env-<timestamp>.json`. 요약은 `results/stage1/SUMMARY.md`. 스모크는 동일 구조로 `results/smoke/`에 기록하고 git에서 제외한다. 저장소에는 본 측정 원본과 요약이 포함되어 있다. 새 실행은 기존 회차를 기본적으로 건너뛰며, 재계산과 새 측정은 별도 명령으로 수행한다.

각 run은 시나리오·공식/프론트 커밋·서버 커밋·조건·회차·시작/종료 시각·원시 지표·차단 요청 수·오류 목록·`ok`를 가진다. `measurement_pool_size`는 풀 상향 조건에서 250, 나머지 조건에서 null이다. `ok`는 스크립트가 끝까지 실행됐는지이며, autoplay의 `failed`나 null 동기화 결과와 별개다. 실패 회차(`ok=false`)만 가능한 샘플/프레임/콘솔을 `browser_artifacts`에 추가 보존한다. 성공 회차는 metrics.raw에 있는 원본을 사용하며 중복 browser_artifacts를 저장하지 않는다. 기존 성공 회차 파일에서는 이 필드를 삭제하지 않는다. 봇은 개별 시도/open/close 코드·지연·수신 건수를 남긴다.

환경 JSON은 Node, Python, 실제 launch에서 얻은 Chromium 버전, CPU 모델·코어 수, 메모리, OS, 전용 Postgres 버전과 `SHOW timezone` 값(`postgres_timezone`), git HEAD와 기준 main, 실행 인자, 시작 부하 평균, Python 의존성을 기록한다. 봇만 실행한 환경의 실제 Chromium 버전은 null이고 Playwright manifest의 예상 버전은 별도 필드다. 브라우저를 실행하지 않고 버전을 만들어 쓰지 않는다.

브라우저 init script는 100ms마다 첫 `audio,video`의 `{t: Date.now(), ct, paused, muted, volume, act}` 또는 `{t, none:true, act}`를 수집한다. 게스트 샘플 시각에서 호스트 위치를 선형 보간해 절대 오차(ms)를 구한다. 게스트와 보간 양 끝의 호스트가 모두 재생 중이어야 유효하다. 외삽하지 않는다. 250ms를 넘는 관측 공백·paused·미디어 없음은 2초 연속 동기화 판정을 끊는다. `act`는 `navigator.userActivation.hasBeenActive`다. `sync_time_ms`는 오차 500ms 미만, 추가 지표 `sync_time_2s_ms`는 오차 2000ms 미만이 각각 2초 유지되는 구간의 시작 시각이다. 2000ms는 앱의 재생 시작 시 보정 기준값이고, 500ms는 자체 목표값이다. 기존 500ms 기준은 그대로 유지한다. late_join의 `ws_reconnects`는 측정 종료 후 읽은 `__wsLog`의 생성 시도 수에서 첫 연결 1개를 뺀 값이다. 지정 시점 오차는 ±200ms 안의 가장 가까운 샘플이며 없으면 null이다.

late_join의 마지막 10초 오차 p50/p75/p95는 유효 샘플에서 계산한다. autoplay는 재생 중인 샘플에서 ct가 0.2초 이상 증가한 첫 확인 시각을 사용한다. 연속 두 샘플 사이 ct 증가량이 경과 초의 2배+0.05초를 넘거나 ct가 감소하면 seek로 보고 기준 샘플을 다시 잡는다. 큰 샘플 간격에도 같은 식을 적용하며 0.2초 진행 기준은 유지한다. audible은 추가로 muted=false, volume>0이어야 한다. 모든 회차별 값은 그대로 저장하고 요약에서 회차 중앙값과 nearest-rank p75/p95를 구한다. 회차가 5개면 nearest-rank p95는 최댓값과 같다. null/미기록은 0으로 바꾸지 않으며 결측 회차 수를 표시한다. 실패한 회차도 원본과 회차 수에 남긴다.

late_join과 autoplay는 `host_unexpected_pauses`, `guest_unexpected_pauses`를 기록한다. 호스트는 `readyHost`의 마지막 실제 재생 클릭 시각(`raw.host_last_play_click_at`) 이후 첫 `paused=false` 샘플부터 `false → true` 전환만 센다. 게스트도 첫 재생 샘플 이전의 초기 paused 상태는 세지 않는다. 미디어 요소가 없는 구간을 가로질러 전환을 추정하지 않는다. `host_unexpected_pauses > 0`인 회차는 모든 지표의 중앙값·p75·p95에서 제외하고 요약 표의 「호스트 멈춤 무효 회차」로 표시한다. `activation_before_first_click`은 첫 trusted click 전(클릭이 없으면 측정 종료 전) 샘플에 `act=true`가 있으면 true이며, true인 회차도 같은 집계에서 제외하고 「활성화 오염 무효 회차」로 표시한다. `injection_effective=false`인 주입 무효 회차도 제외한다. 세 무효 사유가 겹치면 각 사유의 건수에 표시하되 통계에서는 한 번만 제외한다. 원본은 그대로 유지하며 삭제하거나 자동 재시도하지 않는다. 결측 회차는 이 제외 후의 회차에서 센다. 게스트 멈춤은 표시만 하며 집계 제외 사유가 아니다.

late_join과 autoplay의 게스트는 관찰 중 Node가 페이지를 평가하지 않는다. `enter`의 goto 이후에는 콘솔 수신·대기·실제 mouse 입력만 수행하며, 관찰 종료 후 `readObservation`으로 샘플·클릭·WebSocket 로그를 한꺼번에 읽는다. autoplay의 들림 판정과 대기 계산에 관찰 중 샘플 읽기를 사용하지 않는다. 실패 회차 cleanup의 데이터 읽기도 그 회차 관찰을 중단한 뒤 수행한다.

서버 정리는 SIGTERM 후 10초까지 기다리고, 끝나지 않으면 SIGKILL을 보낸 뒤 다시 10초 안에 종료되는지 확인한다. SIGKILL 후에도 종료되지 않으면 예외다. 회차 JSON의 `server_forced_kills`는 재시작과 마지막 정리에서 강제 종료한 횟수를 합산한다. 강제 종료 자체는 `ok=false` 사유가 아니며, 종료 확인 실패 등 다른 스크립트 오류는 기존처럼 기록한다.

## 기존 재연결 원본의 이동 구간 지표 재계산

측정을 실행하지 않고 기존 이벤트 로그에서 두 이동 구간 지표만 추가하려면 다음 명령을 별도로 실행한다. 이 명령은 원본 JSON을 다시 쓰므로 의도적으로 재계산할 때만 실행한다.

```bash
node loadtest/recompute_reconnect.mjs
node loadtest/summarize.mjs
```

대상은 `results/stage1/reconnect/<sha>/*-14/`, `*-200-pool/`의 `run-*.json`이다. `metrics.raw.bots`, `outage_at`, `listen_at`을 사용하고 시나리오와 같은 `reconnectRollingPeaks` 함수를 호출한다. `metrics.peak_attempts_rolling_1s`, `metrics.peak_opens_rolling_1s`만 추가·갱신하며 다른 필드와 기존 browser_artifacts는 유지한다. 옛 `exponential` 실패 회차와 browser-10은 건드리지 않는다. 필요한 원시 데이터가 없으면 오류로 멈춘다. 결과 파일은 `.gitattributes`로 generated 표시하며 `*.previous-*.json` 백업은 git에서 제외한다.

## 브라우저 스모크 확인 항목과 한계

- `.logs/server-*.log` 시작에 `STAGE1 AI replacement applied: get_ai_welcome_message; client=None` 및 DJ 치환 로그가 있는지 확인한다. 함수가 없는 커밋은 `replacement absent` 로그를 확인한다. AI 치환은 단위 테스트 대신 이 시작 로그로 확인한다.
- 호스트 UI pause/play의 실제 `sync` 전송, 게스트 `sync` 수신과 queue 응답, 클릭의 trusted 시각, 외부 요청 차단 수를 원본에서 확인한다.
- history_race 원본의 A 수신 → 응답 보류 → B 수신 → 전달 순서와 스냅샷을 확인한다. 순서를 충족하지 못하면 결과를 정상 측정으로 해석하지 않는다.
- Chromium 실행이 제한되는 환경에서는 단위 테스트와 문법 검사로 도구를 검증하고, 브라우저 실행이 가능한 환경에서 스모크 로그를 확인한 후 본 측정을 진행한다.
- message_burst와 history_race의 관찰자는 Playwright 조작으로 활성화된 상태다. 이 두 시나리오는 재생 지표를 측정하지 않으며 chatReady/chatText 등의 조작은 그대로 사용한다.
- 200 조건은 재연결 분포만 보려고 풀 상한을 올린 측정용 서버다. 수정 안 한 서버의 상한은 약 15연결이며 이는 2단계에서 잰다. 14 조건은 풀을 수정하지 않은 서버를 사용한다. 풀 상향 결과를 원래 서버의 수용량으로 해석하지 않는다.
- 봇은 한 Node 프로세스의 이벤트 루프·네트워크·CPU 스케줄링 한계가 포함된다. 실제 사용자 200명의 브라우저 부하를 재현하지 않는다. 소수 실제 브라우저 검증은 공식 동작 확인용이다.
- 모든 브라우저에 `--mute-audio`와 `--disable-features=HardwareMediaKeyHandling`을 고정 적용한다. `--mute-audio`는 출력만 끄며 측정에 쓰는 `el.muted`, `el.volume`은 앱이 정한 값 그대로다. 미디어 키 제어 비활성화는 원인이 확정되지 않은 호스트 멈춤을 방지하기 위한 설정이며, 멈춤 원인을 확정하는 근거는 아니다.
- 로컬 영상 파일과 동일 머신 시계의 결과다. 실제 서비스 경로는 YouTube iframe이지만 시험은 로컬 영상 파일이므로 YouTube의 버퍼링과 `handleUnmute`의 YouTube 분기는 재지 않는다. 원격망/운영 부하, 실제 저전력 모드, 확성기에서 소리가 나는지는 재현하지 않는다. audible은 미디어 요소 상태를 기준으로 한다. 무음 허용 여부는 Chromium 정책에도 좌우된다.
- 스모크 수치는 작은 크기의 도구 검증 결과이며 성능 결론에 사용하지 않는다. 로그·캐시·음원·아카이브·전용 DB 데이터는 git에서 제외한다.

## 2단계: 한 방의 인원 증가 (#36)

2단계는 `b86324b` 하나의 프론트 응답성과 재생 상태를 측정한다. 서버 지표는 원인을 설명하는 자료다. 1단계 시나리오·원본을 수정하지 않으며 새 러너와 `stage2/` 모듈을 사용한다. `--instrument`가 없는 서버 실행은 1단계와 동일하다.

준비와 실행(저장소 루트):

```bash
npm ci --prefix loadtest
loadtest/scripts/prepare_profiling.sh
# Chromium 설치와 전용 DB 준비는 위 공통 절차 참조
node loadtest/run_stage2.mjs --smoke
# 스모크 검토 후 본 실행
node loadtest/run_stage2.mjs
node loadtest/summarize_stage2.mjs
```

`prepare_profiling.sh`는 일반 빌드와 프로파일링 빌드를 준비한다. 대상 커밋의 `vite.config.ts`를 그대로 로드하고 `react-dom/client`만 React DOM 19.2의 `react-dom/profiling`으로 alias한다. 이 버전의 profiling 번들은 일반 `scheduler`를 import하므로 scheduler alias가 필요하지 않다(로컬 `react-dom/cjs/react-dom-profiling.profiling.js` 근거). `frontend/dist-profiling`은 chat_accumulation에서만 사용한다. 앱 소스는 바꾸지 않는다.

| 조건 | 서버 | 총 연결 N |
|---|---|---|
| default | 풀 수정 없음 | 2, 10, 14, 15, 16, 25 |
| pool-250 | 측정용 풀 250, overflow 0 | 10, 25, 50, 100, 200 |

N은 호스트·관찰자 각각 실제 브라우저 1개와 봇 N-2개의 합이다. join_burst만 실제 입장자 1개를 추가하고 봇은 N-3개다. default는 약 15연결의 실제 한계를, pool-250은 그 뒤의 병목을 찾는 진단 조건이다. 결과를 섞어서 원래 서버 수용량으로 해석하지 않는다. 회차 기본 3회, 조건별 N 오름차순이다. `--scenario steady|chat_burst|join_burst|chat_accumulation`과 `--runs`를 지원한다(chat_accumulation은 명세대로 고정 3회). pool-250의 같은 시나리오·조건에서 작은 N의 회차가 3개 모두 `setup_failed=true, ok=true`이면 더 큰 N은 서버를 실행하지 않고 `skipped` 원본을 남긴다. default는 건너뛰지 않는다.

회차마다 새 DB·서버·브라우저·봇 자식 프로세스를 만든다. 보통 봇 입장은 50ms마다 시작하며 REST join 후 WS를 연다. 호스트·관찰자는 모두 `no-user-gesture-required`; 관찰자에만 `--enable-precise-memory-info`를 추가한다. 기존 scriptedUser가 관찰자의 소리 켜기를 한 번 클릭한 뒤 멈추며 실제 unmuted/playing 상태를 콘솔 계측으로 확인한다. 출력 음소거·외부 DNS 차단은 그대로다. 모든 봇의 입장 확인 상한은 60초다. 그때 미완료면 `setup_failed`와 연결 수를 저장하고 30초 더 관찰한다. 이는 서비스 실패이므로 `ok=true`이며 배치를 중단하지 않는다. 스크립트 오류만 `ok=false`다.

- steady: 입장 후 10초 안정화, 60초 관찰. 측정 시작 15초에 호스트 UI 일시정지, 18초 재생, 33초 +20초 목표 seek, 48초 일시정지, 51초 재생. 전송 sync 프레임으로 확인하며 원본에 실제 timestamp를 남긴다. range 입력의 목표는 현재 위치+20초이고 실제 값은 포인터의 픽셀 해상도에 따른다. 봇은 합계 2개/초를 순서대로 보내며 N=2는 관찰자 키보드가 이를 대신한다. 관찰자는 별도로 5초마다 한 메시지를 입력한다.
- chat_burst: 입장 후 5초 안정화, 30초 관찰. 각 봇이 매초의 임의 시점에 1개를 보내고 관찰자는 2초마다 입력한다. 관찰자 CPU 1배·4배를 `default`, `default-cpu4`, `pool-250`, `pool-250-cpu4`로 분리한다. 전송 종료 뒤 고정 30초까지 수신을 정리한다. 좋은 값에 따라 대기를 단축하지 않는다.
- join_burst: 호스트·관찰자 입장 후 10초 안정화한다. 봇 N-3개는 3초에 균등하게 입장을 시작한다. 1.5초 시점에 입장자가 랜딩으로 이동해 Join Existing Room → 코드·닉네임 입력 → 제출을 실제 mouse/keyboard로 수행한다. 입장자 sessionStorage는 미리 넣지 않는다. 제출 클릭 직전부터 첫 재생 확인까지 join_ms를 계산하고 입장 후 30초 관찰한다. N<3은 계획에서 제외한다. 입장 완료 상한과 실패 추가 관찰은 공통 규칙과 같다.
- chat_accumulation: default, N=3, 고정 3회이며 profiling 빌드다. 봇이 200개/초로 10,000개를 보내고 1,000/2,000/5,000/10,000개가 화면에 수신될 때마다 콘솔 체크포인트를 내보내 관찰자 키보드 입력 1건을 실행한다. 발신은 멈추지 않는다. 상한 300초, 수신한 만큼 기록한다. 체크포인트의 heap·DOM 노드 수와 앞 구간의 React commit·Long Task 등, 해당 입력 주변 Event Timing의 INP 후보 값을 기록한다.

관찰 중 관찰자 페이지 평가를 하지 않는다. 입력 위치와 체크포인트, 접속 상태는 init script가 콘솔 텍스트로 전달한다. 입력은 page.mouse/page.keyboard만 사용하고 전체 데이터는 관찰 종료 후 읽는다. 미디어 샘플 100ms, heap·DOM 크기 1초, rAF 간격과 longtask PerformanceObserver, React DevTools hook, 버전 고정 `web-vitals@5.1.0` IIFE의 `onINP(reportAllChanges:true)`를 사용한다. INP는 매 회차 새 페이지에서 web-vitals가 보고한 마지막 값이며 초기 소리 켜기 입력도 페이지 수명에 포함된다. 입력 건수는 관찰 중 실제 Enter 이벤트다. 일반 빌드의 React 커밋 시간은 null, profiling은 root.current.actualDuration을 사용한다. heap 시작·끝은 1초 주기의 첫·마지막 유효 샘플이다.

채팅 마커는 `c-<발신자>-<순번>-<ms>`다. 봇은 실제 전송한 마커의 시각, 게스트는 수집기의 `[마커, socket.send 시각]`부터 첫 DOM 표시까지를 전달 지연으로 계산한다. 키보드 타이핑 시간은 포함하지 않는다. 전송하지 못한 봇 메시지는 `bot_unsent`, 입력했지만 소켓으로 나가지 않은 게스트 메시지는 `guest_unsent`로 따로 세고 유실·지연 계산에서 제외한다. MutationObserver는 변경된 텍스트 노드만 살피고 최초 표시 시각을 저장한다. 마커별 최대 동시 표시 수의 초과분을 duplicates로 세며 DOM 노드 이동·재사용은 중복으로 세지 않는다. 미표시 마커는 lost, 첫 봇이 못 받은 마커는 server_side_lost이고 N=2는 null이다. 봇의 수신은 계속 소모하며 대조 봇만 문자열에서 마커를 찾고 모든 프레임을 JSON 파싱하지 않는다.

오차는 1단계 positionErrors를 사용한다. steady의 첫 pause 이전은 join_err_p50/p75/p95, 그 뒤 첫 resume부터는 err_p50/p75/p95다(ms). 양쪽의 paused 샘플, 명시적 pause→play 구간, 명시적 seek 후 1.5초는 제외한다. 최신 수신 action이 play이고 1초 안에 발생한 seeking만 play_correction_seeks다. 첫 pause 이전(입장 시)의 seeking과 pause/seek 뒤의 seeking은 제외한다. dropped_frames는 `max(0, round(delta/16.67)-1)` 합, total_frames는 관찰 구간의 rAF 수다. Long Task는 측정 구간에 시작한 작업의 횟수·전체 duration 합이다. chat_burst의 렌더링 지표는 30초 부하 구간, 전달·마지막 INP·입력 완료는 정리 구간까지 확인한다.

봇은 child_process.fork로 분리한다. Full jitter의 5회 재시도와 open 때 카운터 초기화를 그대로 사용한다. 개별 입장 시간, 끊김·close code·시도 소진, monitorEventLoopDelay(20ms resolution)의 최댓값과 p95를 기록한다. 서버의 선택적 `--instrument <loadtest 안 파일>`은 asyncio 100ms 지연, async broadcast 소요 시간·연결 수, 1초 pool checkedout/overflow를 JSONL에 기록한다. 각 초 count·sum·max·상한 버킷 기반 p95 근사를 저장하며 메시지마다 파일을 쓰지 않는다. Node는 1초마다 ps의 CPU·RSS를 수집하고 끝에 서버 로그의 QueuePool 등장 횟수를 센다. SIGKILL 횟수도 회차에 남긴다. `server_summary`에는 관찰 구간의 이벤트 루프 지연 최댓값·초당 p95 근사의 최댓값, broadcast p95 근사의 최댓값·합계 ms, 최대 연결 수·pool checked_out, CPU·RSS 최댓값을 계산한다. JSONL은 집계 종료 시각이 관찰 구간 안인 초 단위 행, ps는 구간 안의 샘플을 사용한다. QueuePool·강제 종료 횟수는 회차 전체 값이다. 이 값과 연결 끊김·포기·입장 실패·설정 완료 연결 수·호스트 동기화 시간 초과·미전송 수도 요약 표에 중앙값·최댓값으로 남긴다.

결과는 `results/stage2/<scenario>/b86324b/<condition>/n-<N>/run-<k>.json`, 환경은 같은 루트의 env JSON, 요약은 `results/stage2/SUMMARY.md`다. 원시 WS 프레임과 browser_artifacts는 저장하지 않고 미디어 샘플·값 배열·집계를 compact JSON으로 저장한다. 2MiB를 넘는 진단 배열이 생기면 샘플과 집계를 유지하고 배열 생략 이유를 남긴 스크립트 실패로 저장한다. 기존 결과는 성공 여부와 무관하게 건너뛰며 명시적 --force만 백업 후 재실행한다. 실패 회차를 자동 재시도하지 않는다.

호스트 UI 조작 뒤 5초 내 sync 프레임이 없으면 `host_action_timeouts`에 세고 계속한다. 입력 큐가 완료 기한(일반 시나리오 30초) 안에 끝나지 않으면 `input_stuck=true`다. 관찰 후 스냅샷 평가에 15초간 응답하지 않으면서 페이지가 열려 있고 브라우저 연결이 살아 있으면 `page_unresponsive=true`로 기록하고 읽을 수 없는 값은 null로 둔다. 좌표 누락·평가 예외·페이지 crash/종료·브라우저 연결 종료처럼 판별 불가능하거나 도구에서 발생한 오류는 스크립트 실패로 남긴다. 두 서비스 상태는 `ok=true`를 유지하며 각각 `HOST_SYNC_TIMEOUT`, `PAGE_STUCK`으로 불합격이다.

판정은 2026-11-04 확정한 규칙을 고정한다. PLAY_CORRECTION(steady), LOST, DUPLICATES, BOT_LOST, JOIN_FAILED, RETRY_EXHAUSTED, SETUP_FAILED, QUEUE_POOL, DISCONNECTED는 불합격 사유다. SCRIPT_ERROR도 표에서 FAIL이다. 한 회차라도 FAIL이면 같은 N은 FAIL이며 결측을 0으로 바꾸거나 회차를 제외하지 않는다. INP 200ms·전달 p95 1000ms는 시험 조건의 외부 기준 초과 여부를 별도 표시하고, err_p95 500ms는 공인 기준이 없는 자체 목표다. p75/p95를 포함한 각 지표의 회차 중앙값·최댓값을 남긴다. Long Task·프레임은 기록만 한다. 봇 이벤트 루프 p95 >100ms는 측정기 부하로 표시해 지연 값의 신뢰 한계를 설명하며 제외하지 않는다.

스모크는 N=2/10, pool-250은 N=10, 회차 1회다. steady 20초, chat_burst 10초(정리 상한은 동일), join_burst 입장 후 10초, accumulation은 N=3에서 500개·체크포인트 100/500이다. CPU 4배도 포함한다.

브라우저 없는 실제 서버·봇 기능 확인은 다음 명령이며, 측정 원본 대신 무시되는 .logs에 검증 로그를 남긴다. 중간 실패 로그도 보존한다.

```bash
node --test loadtest/test
node loadtest/stage2/validate_backend.mjs
```

한계: 봇과 측정 대상이 같은 머신의 CPU·네트워크·DB를 공유한다. 봇은 렌더하지 않으며 실제 프론트 관찰자는 1명이다. 키보드·마우스 입력은 스크립트이므로 실제 사용자 행동 분포가 아니다. 4배 CPU 스로틀은 지정한 관찰자 페이지에만 적용된다. macOS의 ps `%cpu`는 평균이 섞인 값이므로 순간 CPU 사용률로 해석하지 않는다. 로컬 영상 파일·동일 머신 시계·차단된 외부 요청 조건이며 원격 YouTube·실제 스피커 출력·운영 트래픽을 재현하지 않는다. 마커·샘플·성능 관측 배열의 계측 비용도 CPU·힙에 포함된다. 프로파일링 빌드의 추가 비용이 있으므로 accumulation 시간은 일반 빌드 시간과 직접 비교하지 않는다.
