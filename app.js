(function () {
  'use strict';

  var MIN_ORIGINS = 2;
  var MAX_ORIGINS = 8;
  var LABELS = 'ABCDEFGH';
  var API_URL = window.MOYEORA_API_URL || 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2026-10-21';
  var MODEL = 'claude-opus-5-5';
  var REQUEST_TIMEOUT_MS = 90000;
  var KEY_STORE = 'moyeora.apiKey';
  var IDLE_LABEL = '🔍 최적 장소 AI 분석하기';

  var form = document.getElementById('meetup-form');
  var originList = document.getElementById('origin-list');
  var addBtn = document.getElementById('add-origin');
  var conditions = document.getElementById('conditions');
  var charCount = document.getElementById('char-count');
  var budget = document.getElementById('budget');
  var budgetLabel = document.getElementById('budget-label');
  var errorEl = document.getElementById('form-error');
  var analyzeBtn = document.getElementById('analyze-btn');
  var result = document.getElementById('result');
  var loading = document.getElementById('loading');
  var apiKeyInput = document.getElementById('api-key');
  var modeBadge = document.getElementById('mode-badge');
  var tabSetup = document.getElementById('tab-setup');
  var tabResult = document.getElementById('tab-result');
  var panelSetup = document.getElementById('panel-setup');
  var panelResult = document.getElementById('panel-result');
  var resultEmpty = document.getElementById('result-empty');
  var paneLeft = document.getElementById('pane-left');

  /* ───────────── 입력 폼 (기존 로직) ───────────── */

  function formatBudget(v) {
    v = Number(v);
    if (v >= 100000) return '제한 없음';
    return (v / 10000) + '만 원 이하';
  }

  function updateBudget() {
    budgetLabel.textContent = formatBudget(budget.value);
    document.querySelectorAll('#budget-presets .chip').forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.value === String(budget.value));
    });
    syncTemplates();
  }

  /* 출발지 행: 항상 A, B, C… 순서로 다시 라벨링하고 최소 2개 / 최대 8개를 유지 */
  function relabelOrigins() {
    var rows = originList.querySelectorAll('.origin-row');
    rows.forEach(function (row, i) {
      row.querySelector('.badge').textContent = LABELS[i];
      row.querySelector('input').setAttribute('aria-label', '출발 위치 ' + LABELS[i]);
      var rm = row.querySelector('.origin-remove');
      rm.setAttribute('aria-label', '출발지 ' + LABELS[i] + ' 삭제');
      var g = row.querySelector('.origin-gps');
      if (g) g.setAttribute('aria-label', '출발지 ' + LABELS[i] + '를 내 위치로 입력');
      rm.disabled = rows.length <= MIN_ORIGINS;
    });
    addBtn.disabled = rows.length >= MAX_ORIGINS;
  }

  function addOrigin(noFocus) {
    if (originList.querySelectorAll('.origin-row').length >= MAX_ORIGINS) return;
    var row = document.createElement('div');
    row.className = 'origin-row';
    var badge = document.createElement('b');
    badge.className = 'badge';
    var input = document.createElement('input');
    input.type = 'text';
    input.name = 'origin';
    input.placeholder = '출발 위치 입력';
    input.autocomplete = 'off';
    var gps = document.createElement('button');
    gps.type = 'button';
    gps.className = 'origin-gps';
    gps.title = '현재 GPS 위치로 입력';
    gps.appendChild(document.createTextNode('📍'));
    var gpsText = document.createElement('span');
    gpsText.textContent = '내 위치';
    gps.appendChild(gpsText);
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'origin-remove';
    rm.title = '삭제';
    rm.textContent = '✕';
    row.appendChild(badge);
    row.appendChild(input);
    row.appendChild(gps);
    row.appendChild(rm);
    originList.appendChild(row);
    relabelOrigins();
    if (noFocus !== true) input.focus();
  }

  originList.addEventListener('click', function (e) {
    var gps = e.target.closest('.origin-gps');
    if (gps) { useMyLocation(gps.closest('.origin-row')); return; }
    var rm = e.target.closest('.origin-remove');
    if (!rm || rm.disabled) return;
    var rows = originList.querySelectorAll('.origin-row');
    if (rows.length <= MIN_ORIGINS) return;
    rm.closest('.origin-row').remove();
    relabelOrigins();
  });

  // 직접 수정하면 GPS로 받아 둔 좌표는 폐기 (입력창 내용과 좌표가 어긋나지 않게)
  originList.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('input')) { delete e.target.dataset.lat; delete e.target.dataset.lng; }
  });

  var geoStatus = document.getElementById('geo-status');
  function setGeoStatus(msg, isErr) {
    geoStatus.textContent = msg;
    geoStatus.hidden = !msg;
    geoStatus.className = 'geo-status' + (isErr ? ' geo-status--err' : '');
  }

  // Nominatim 역지오코딩으로 "서울 강남구 테헤란로 152" 같은 짧은 주소 문자열을 만든다
  function reverseAddress(c) {
    return nominatimGet('/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=ko&lat=' + c.lat + '&lon=' + c.lng).then(function (d) {
      var a = (d && d.address) || {};
      var parts = [
        a.city || a.province || a.state || '',
        a.borough || a.city_district || a.county || '',
        a.road ? a.road + (a.house_number ? ' ' + a.house_number : '') : (a.suburb || a.quarter || a.neighbourhood || '')
      ];
      var text = parts.filter(Boolean).join(' ');
      return text || String((d && d.display_name) || '').split(',').slice(0, 2).join(' ').trim();
    }).catch(function () { return ''; });
  }

  function useMyLocation(row) {
    var input = row.querySelector('input'), btn = row.querySelector('.origin-gps');
    if (!navigator.geolocation) { setGeoStatus('이 브라우저는 위치 기능을 지원하지 않아요.', true); return; }
    btn.disabled = true;
    btn.classList.add('is-busy');
    setGeoStatus('📡 현재 위치를 확인하는 중이에요… (위치 권한을 허용해 주세요)', false);
    function done() { btn.disabled = false; btn.classList.remove('is-busy'); }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = r4(pos.coords.latitude), lng = r4(pos.coords.longitude);
      if (!validCoord(lat, lng)) {
        done();
        setGeoStatus('대한민국 안의 위치만 지원해요. (현재 위치: ' + lat + ', ' + lng + ')', true);
        return;
      }
      input.dataset.lat = String(lat);
      input.dataset.lng = String(lng);
      input.value = '현재 위치';
      setGeoStatus('📍 주소를 찾는 중이에요…', false);
      reverseAddress({ lat: lat, lng: lng }).then(function (addr) {
        done();
        if (input.dataset.lat !== String(lat)) return; // 그 사이 직접 수정했으면 덮어쓰지 않음
        input.value = addr || ('현재 위치 (' + lat + ', ' + lng + ')');
        setGeoStatus('✓ 현재 위치를 입력했어요: ' + input.value, false);
      });
    }, function (err) {
      done();
      setGeoStatus(err && err.code === 1 ? '위치 권한이 거부됐어요. 브라우저 주소창의 권한 설정에서 허용해 주세요.' :
        err && err.code === 3 ? '위치 확인 시간이 초과됐어요. 다시 시도해 주세요.' : '현재 위치를 가져오지 못했어요. 직접 입력해 주세요.', true);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  addBtn.addEventListener('click', function () { addOrigin(); }); // 클릭 이벤트 객체가 noFocus로 넘어가지 않게 감쌈

  /* 조건 칩(멀티 선택 토글) ↔ 입력창 양방향 동기화.
     입력창은 쉼표로 구분된 토큰 목록으로 보고, 칩 텍스트와 일치하는 토큰이 있으면 그 칩이 ON. */
  // 네이버 지도 검색 필터처럼 6개 카테고리로 구성. [표시 라벨, 입력창에 들어가는 문구]
  // 문구는 퀵 템플릿 태그·로컬 분석 키워드(공원|스터디|전시|30분 …)와 맞춰져 있다.
  var CHIP_GROUPS = [
    { key: '목적', chips: [['식사', '식사'], ['회식', '회식'], ['스터디·작업', '스터디·작업하기 좋은 곳'], ['산책', '공원·산책'], ['데이트', '데이트'], ['미팅', '미팅'], ['전시·공연', '전시·공연']] },
    { key: '테마', chips: [['카페·디저트', '카페·디저트'], ['이자카야', '이자카야'], ['고기·구이', '고기·구이'], ['한식', '한식'], ['양식·파스타', '양식·파스타'], ['브런치', '브런치']] },
    { key: '분위기', chips: [['조용한', '조용한 곳'], ['감성적인', '감성적인'], ['분위기 좋은', '분위기 좋은 곳'], ['활기찬', '활기찬'], ['프라이빗', '프라이빗'], ['뷰 좋은', '뷰 좋은 곳']] },
    { key: '시설/서비스', chips: [['주차', '주차 가능'], ['룸', '룸 있는 곳'], ['단체석', '단체석 가능'], ['24시', '24시'], ['휠체어', '휠체어 접근 가능'], ['콘센트', '콘센트·와이파이'], ['예약', '예약 가능'], ['반려동물', '반려동물 동반']] },
    { key: '속성', chips: [['가성비', '가성비 좋은 곳'], ['대형', '대형·넓은 곳'], ['지하철 30분 이내', '지하철 30분 이내'], ['빠른 식사', '빠른 식사'], ['웨이팅 짧은', '웨이팅 짧은 곳']] },
    { key: '영업시간', chips: [['심야', '심야 영업'], ['주말 오전', '주말 오전 영업'], ['브레이크타임 없음', '브레이크타임 없음'], ['이른 아침', '이른 아침 영업']] }
  ];

  function renderChipGroups() {
    var box = document.getElementById('chips');
    CHIP_GROUPS.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'fgroup';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', g.key);
      var label = document.createElement('span');
      label.className = 'fgroup__label';
      label.textContent = g.key;
      var wrap = document.createElement('div');
      wrap.className = 'fgroup__chips';
      g.chips.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip chip--sm';
        b.dataset.text = c[1];
        b.setAttribute('aria-pressed', 'false');
        b.textContent = c[0];
        wrap.appendChild(b);
      });
      row.appendChild(label);
      row.appendChild(wrap);
      box.appendChild(row);
    });
  }

  renderChipGroups();
  var chipEls = document.querySelectorAll('#chips .chip');
  var chipCountEl = document.getElementById('chip-count');

  function conditionTokens() {
    return conditions.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function syncChips() {
    var tokens = conditionTokens(), n = 0;
    chipEls.forEach(function (c) {
      var on = tokens.indexOf(c.dataset.text) !== -1;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) n++;
    });
    chipCountEl.textContent = '선택 ' + n + '개';
    syncTemplates();
  }

  /* 퀵 템플릿: 모임 성격 → 조건 태그 + 예산 슬라이더 자동 조합.
     태그 문구는 위 조건 칩의 data-text와 맞춰서, 적용하면 해당 칩도 같이 켜진다. */
  var TEMPLATES = [
    { id: 'club', icon: '🎉', name: '동아리·대형회식', tags: ['단체석 가능', '가성비 좋은 곳', '지하철 30분 이내'], budget: 20000 },
    { id: 'biz', icon: '💼', name: '비즈니스·미팅', tags: ['조용한 곳', '룸 있는 곳', '예약 가능', '지하철 30분 이내'], budget: 50000 },
    { id: 'cafe', icon: '☕', name: '감성 카페·디저트', tags: ['분위기 좋은 곳', '카페·디저트', '조용한 곳'], budget: 20000 },
    { id: 'mood', icon: '🥂', name: '분위기 모임', tags: ['분위기 좋은 곳', '이자카야', '조용한 곳'], budget: 50000 },
    { id: 'meat', icon: '🥩', name: '든든한 1차 고기', tags: ['고기·구이', '가성비 좋은 곳', '단체석 가능'], budget: 30000 },
    { id: 'quick', icon: '⏱️', name: '속성 1시간 컷', tags: ['지하철 30분 이내', '빠른 식사', '웨이팅 짧은 곳'], budget: 20000 }
  ];
  var tplEls = [];

  function renderTemplates() {
    var box = document.getElementById('templates');
    TEMPLATES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tpl';
      b.dataset.tpl = t.id;
      b.setAttribute('aria-pressed', 'false');
      var icon = document.createElement('span'); icon.className = 'tpl__icon'; icon.textContent = t.icon; icon.setAttribute('aria-hidden', 'true');
      var name = document.createElement('span'); name.className = 'tpl__name'; name.textContent = t.name;
      b.title = t.name + ' · ' + formatBudget(t.budget);
      b.appendChild(icon); b.appendChild(name);
      box.appendChild(b);
      tplEls.push(b);
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('.tpl');
      if (!b) return;
      var t = TEMPLATES.filter(function (x) { return x.id === b.dataset.tpl; })[0];
      if (!t) return;
      conditions.value = t.tags.join(', ');
      budget.value = t.budget;
      conditions.dispatchEvent(new Event('input')); // 글자 수·칩·템플릿 상태 갱신
      updateBudget();
    });
  }

  // 현재 입력(태그 집합 + 예산)이 템플릿과 정확히 일치할 때만 그 템플릿을 '선택됨'으로 표시
  function syncTemplates() {
    var tokens = conditionTokens(), bud = Number(budget.value);
    tplEls.forEach(function (b, i) {
      var t = TEMPLATES[i];
      var on = bud === t.budget && tokens.length === t.tags.length &&
        t.tags.every(function (x) { return tokens.indexOf(x) !== -1; });
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  conditions.addEventListener('input', function () {
    charCount.textContent = conditions.value.length;
    syncChips();
  });

  document.getElementById('chips').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    var text = chip.dataset.text;
    var tokens = conditionTokens();
    var idx = tokens.indexOf(text);
    if (idx !== -1) tokens.splice(idx, 1); else tokens.push(text);
    var next = tokens.join(', ');
    if (idx === -1 && next.length > conditions.maxLength) return; // 글자 수 제한 초과 시 추가하지 않음
    conditions.value = next;
    conditions.dispatchEvent(new Event('input'));
  });

  // 칩으로 고른 항목만 지우고, 직접 입력한 문구는 남긴다
  document.getElementById('chip-reset').addEventListener('click', function () {
    var texts = {};
    chipEls.forEach(function (c) { texts[c.dataset.text] = true; });
    conditions.value = conditionTokens().filter(function (t) { return !texts[t]; }).join(', ');
    conditions.dispatchEvent(new Event('input'));
  });

  budget.addEventListener('input', updateBudget);
  document.getElementById('budget-presets').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    budget.value = chip.dataset.value;
    updateBudget();
  });

  /* ───────────── 음성 입력 + 의도 파싱 (Intent Parser) ───────────── */

  // ── 파이썬(GPU) 백엔드 연동 스텁 ──────────────────────────────────────────────
  // 켜는 법: window.MOYEORA_BACKEND_URL = 'http://localhost:8000' 또는 localStorage['moyeora.backend'] 에 주소 저장.
  // 주소가 없으면 어떤 요청도 보내지 않고, 있어도 /health 응답이 없으면 자동으로 로컬 방식으로 대체한다.
  //   GET  /health  → { stt: true, intent: true, gpu: "RTX ..." }
  //   POST /stt     (multipart: audio=<webm|mp4 blob>, lang=ko)                  → { text: "인식된 문장" }
  //   POST /intent  (json: { text, lang, vocabulary: { 목적: [...], 테마: [...] } })
  //                 → { tokens: ["스터디·작업하기 좋은 곳", ...], budget: 30000|null, minutes: 30|null, area: "강남"|null }
  //                 tokens 는 vocabulary 에 있는 문구만 인정한다(그 외는 무시).
  // 오디오는 인식이 끝나는 즉시 버리며 어디에도 저장하지 않는다.
  var BACKEND_URL = (window.MOYEORA_BACKEND_URL || (function () {
    try { return localStorage.getItem('moyeora.backend') || ''; } catch (e) { return ''; }
  })() || '').replace(/\/+$/, '');
  var backendInfo = { at: 0, ok: false, stt: false, intent: false, gpu: '' };

  function backendProbe() {
    if (!BACKEND_URL) return Promise.resolve(backendInfo);
    if (Date.now() - backendInfo.at < 30000) return Promise.resolve(backendInfo); // 30초 캐시
    return fetchJson(BACKEND_URL + '/health', 1500).then(function (h) {
      backendInfo = { at: Date.now(), ok: true, stt: !!(h && h.stt), intent: !!(h && h.intent), gpu: String((h && h.gpu) || '') };
      return backendInfo;
    }, function () {
      backendInfo = { at: Date.now(), ok: false, stt: false, intent: false, gpu: '' };
      return backendInfo;
    });
  }

  function backendTranscribe(blob) {
    var fd = new FormData();
    fd.append('audio', blob, 'voice.webm');
    fd.append('lang', 'ko');
    return fetchJson(BACKEND_URL + '/stt', 15000, { method: 'POST', body: fd }).then(function (j) {
      if (!j || typeof j.text !== 'string') throw new Error('bad stt response');
      return j.text;
    });
  }

  function backendIntent(text) {
    return fetchJson(BACKEND_URL + '/intent', 5000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, lang: 'ko', vocabulary: INTENT_VOCAB })
    }).then(function (j) { return sanitizeIntent(j, 'server'); });
  }

  // ── 어휘: 조건 칩과 같은 문구만 사용 (서버·로컬 모두 이 어휘 안에서 고른다) ──
  var INTENT_VOCAB = {}, TOKEN_LABEL = {}, TOKEN_GROUP = {};
  CHIP_GROUPS.forEach(function (g) {
    INTENT_VOCAB[g.key] = g.chips.map(function (c) { return c[1]; });
    g.chips.forEach(function (c) { TOKEN_LABEL[c[1]] = c[0]; TOKEN_GROUP[c[1]] = g.key; });
  });

  function snapBudget(won) {
    if (!isFinite(won)) return null;
    if (won >= 100000) return 100000;
    return Math.max(10000, Math.round(won / 5000) * 5000);
  }

  function sanitizeIntent(j, source) {
    j = j || {};
    var seen = {};
    var tokens = (Array.isArray(j.tokens) ? j.tokens : []).map(String).filter(function (t) {
      if (seen[t]) return false;
      var ok = !!TOKEN_LABEL[t] || /^지하철 \d{1,3}분 이내$/.test(t);
      if (ok) seen[t] = true;
      return ok;
    });
    var minutes = Number(j.minutes);
    return {
      tokens: tokens,
      budget: j.budget == null ? null : snapBudget(Number(j.budget)),
      minutes: isFinite(minutes) && minutes > 0 && minutes <= 300 ? Math.round(minutes) : null,
      area: typeof j.area === 'string' && j.area.trim() ? j.area.trim().slice(0, 20) : null,
      source: source
    };
  }

  // ── 로컬 규칙 엔진: 키워드 → 칩 문구 ──
  var INTENT_RULES = [
    ['스터디·작업하기 좋은 곳', /스터디|공부|작업|노트북|과제|코워킹/],
    ['회식', /회식|동아리|뒤풀이/],
    ['식사', /식사|밥|점심|저녁|런치|디너/],
    ['공원·산책', /공원|산책|피크닉|야외/],
    ['데이트', /데이트|연인|커플|소개팅/],
    ['미팅', /미팅|비즈니스|회의|면접/],
    ['전시·공연', /전시|공연|영화|박물관|미술|연극|뮤지컬/],
    ['카페·디저트', /카페|커피|디저트|베이커리/],
    ['이자카야', /이자카야|술집|맥주|한잔|호프/],
    ['고기·구이', /고기|구이|삼겹|갈비|곱창/],
    ['한식', /한식|국밥|백반|찌개/],
    ['양식·파스타', /양식|파스타|스테이크|피자/],
    ['브런치', /브런치/],
    ['조용한 곳', /조용|한적|차분|고요/],
    ['감성적인', /감성|예쁜|아늑|인스타/],
    ['분위기 좋은 곳', /분위기/],
    ['활기찬', /활기|북적|시끌|신나/],
    ['프라이빗', /프라이빗|단독|독채/],
    ['뷰 좋은 곳', /뷰|전망|야경|경치|루프탑/],
    ['주차 가능', /주차/],
    ['룸 있는 곳', /룸|별실/],
    ['단체석 가능', /단체석|단체|넓은 자리/],
    ['24시', /24\s*시|밤샘|새벽/],
    ['휠체어 접근 가능', /휠체어|단차|배리어프리|엘리베이터/],
    ['콘센트·와이파이', /콘센트|와이파이|wi-?fi|충전|플러그/i],
    ['예약 가능', /예약/],
    ['반려동물 동반', /반려|애견|강아지|펫/],
    ['가성비 좋은 곳', /가성비|저렴|싼|합리적/],
    ['대형·넓은 곳', /대형|넓은|큰 /],
    ['빠른 식사', /빠른|빨리|간단히|속성/],
    ['웨이팅 짧은 곳', /웨이팅|대기|줄 서/],
    ['심야 영업', /심야|늦게까지|밤늦|야식|2[23]\s*시|자정/],
    ['주말 오전 영업', /(?:주말|토요일|일요일)\s*오전/],
    ['브레이크타임 없음', /브레이크\s*타임\s*없|쉬는\s*시간\s*없/],
    ['이른 아침 영업', /이른\s*아침|아침\s*일찍|모닝/]
  ];
  var AREA_STOP = { '여기': 1, '저기': 1, '우리': 1, '이쪽': 1, '저쪽': 1, '집': 1, '회사': 1, '학교': 1 };

  function localIntent(text) {
    // "스터디카페"는 카페 테마가 아니라 스터디 목적으로 해석한다
    var t = String(text).replace(/스터디\s*카페/g, '스터디');
    var tokens = [];
    INTENT_RULES.forEach(function (r) {
      var m = r[1].exec(t);
      if (!m) return;
      // "주차 안 되는", "조용하지 않은", "~말고" 같은 부정 표현은 제외
      var after = t.slice(m.index + m[0].length, m.index + m[0].length + 8);
      if (/^[가-힣]{0,2}\s*(지\s*않|안\s*되|안되|말고|빼고|제외|싫)/.test(after)) return;
      tokens.push(r[0]);
    });

    var budget = null;
    var bm = /(\d+(?:\.\d+)?)\s*만\s*원?/.exec(t);
    if (bm) budget = snapBudget(parseFloat(bm[1]) * 10000);

    var minutes = null;
    var mm = /지하철\s*(\d+)\s*분|(\d+)\s*분\s*(?:이내|안에|안쪽|거리|정도)/.exec(t);
    if (mm) minutes = Number(mm[1] || mm[2]);
    if (minutes) tokens.push(minutes === 30 ? '지하철 30분 이내' : '지하철 ' + minutes + '분 이내');

    var area = null;
    var am = /([가-힣A-Za-z0-9]{2,12}?)\s*(?:근처|주변|부근|인근|쪽)/.exec(t) || /([가-힣A-Za-z0-9]{2,10})에서\s*(?:모|만나|보)/.exec(t);
    if (am) {
      area = am[1].replace(/(?:에서|에|의|이랑|랑|하고)$/, '');
      if (area.length < 2 || AREA_STOP[area]) area = null;
    }
    return { tokens: tokens, budget: budget, minutes: minutes, area: area, source: 'local' };
  }

  // 서버(/intent)가 켜져 있으면 서버 결과를, 아니면(또는 실패하면) 로컬 규칙 결과를 돌려준다
  function parseIntentAsync(text) {
    return backendProbe().then(function (info) {
      if (info.ok && info.intent) {
        return backendIntent(text).catch(function () {
          var r = localIntent(text);
          r.fellBack = true;
          return r;
        });
      }
      return localIntent(text);
    });
  }

  // ── 입력 반영 + AI 입력 요약 카드 ──
  var intentBox = document.getElementById('intent-summary');

  function applyIntent(res) {
    var prev = { conditions: conditions.value, budget: budget.value };
    var cur = conditionTokens(), skipped = 0;
    res.tokens.forEach(function (t) {
      if (cur.indexOf(t) !== -1) return;
      if (cur.concat([t]).join(', ').length > conditions.maxLength) { skipped++; return; }
      cur.push(t);
    });
    conditions.value = cur.join(', ');
    conditions.dispatchEvent(new Event('input')); // 글자 수·칩·템플릿 상태 갱신
    if (res.budget != null) { budget.value = res.budget; updateBudget(); }
    renderIntentSummary(res, prev, skipped);
  }

  function fillOriginWithArea(area) {
    var inputs = originList.querySelectorAll('input');
    var target = null;
    inputs.forEach(function (i) { if (!target && !i.value.trim()) target = i; });
    if (!target) {
      addOrigin(true);
      var all = originList.querySelectorAll('input');
      target = all[all.length - 1];
    }
    target.value = area;
    delete target.dataset.lat;
    delete target.dataset.lng;
    target.focus();
  }

  function renderIntentSummary(res, prev, skipped) {
    intentBox.textContent = '';
    intentBox.hidden = false;
    var found = res.tokens.length > 0 || res.budget != null || !!res.area;

    var main = el('div', 'intent__main');
    main.appendChild(el('span', 'intent__icon', '🤖'));
    var text = el('span', 'intent__text');
    if (res.tokens.length) {
      res.tokens.forEach(function (t, i) {
        if (i) text.appendChild(document.createTextNode(' · '));
        var tag = el('span', 'intent__tag', '[' + (TOKEN_LABEL[t] || t) + ']');
        tag.title = TOKEN_GROUP[t] || '속성';
        text.appendChild(tag);
      });
      text.appendChild(document.createTextNode(' 조건으로 해석했어요!'));
    } else if (found) {
      text.textContent = '필터 칩으로 바꿀 키워드는 없었지만 아래 정보를 찾았어요.';
    } else {
      text.textContent = '해석할 조건 키워드를 찾지 못했어요. 아래 칩에서 직접 골라 보세요.';
    }
    main.appendChild(text);
    var src = el('span', 'intent__src' + (res.source === 'server' ? ' intent__src--server' : ''),
      res.source === 'server' ? 'AI 서버' + (backendInfo.gpu ? '(GPU)' : '') : '로컬 규칙'); // /health 가 gpu 를 알려줄 때만 GPU 로 표기
    main.appendChild(src);
    intentBox.appendChild(main);

    var meta = el('div', 'intent__meta');
    if (res.area) {
      meta.appendChild(el('span', 'pill', '📍 ' + res.area + ' 근처'));
      var put = el('button', null, '출발지에 넣기');
      put.type = 'button';
      put.addEventListener('click', function () { fillOriginWithArea(res.area); });
      meta.appendChild(put);
    }
    if (res.budget != null) meta.appendChild(el('span', 'pill', '💰 ' + formatBudget(res.budget)));
    if (found) {
      var undo = el('button', null, '↩ 되돌리기');
      undo.type = 'button';
      undo.addEventListener('click', function () {
        conditions.value = prev.conditions;
        conditions.dispatchEvent(new Event('input'));
        budget.value = prev.budget;
        updateBudget();
        intentBox.hidden = true;
      });
      meta.appendChild(undo);
    }
    if (meta.childNodes.length) intentBox.appendChild(meta);

    var notes = [];
    if (res.fellBack) notes.push('AI 서버에 연결하지 못해 로컬 규칙으로 해석했어요.');
    if (skipped) notes.push('글자 수 제한으로 ' + skipped + '개는 반영하지 못했어요.');
    if (notes.length) intentBox.appendChild(el('p', 'intent__note', notes.join(' ')));
  }

  // ── 음성 수집 UI ──
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var vBtn = document.getElementById('voice-btn');
  var vBtnText = document.getElementById('voice-btn-text');
  var vListening = document.getElementById('voice-listening');
  var vInterim = document.getElementById('voice-interim');
  var vConfirm = document.getElementById('voice-confirm');
  var vText = document.getElementById('voice-text');
  var vNote = document.getElementById('voice-note');
  var vApply = document.getElementById('voice-apply');
  var vMode = document.getElementById('voice-mode');
  var voice = { state: 'idle', stopFn: null };

  function currentVoiceMode() {
    if (backendInfo.ok && backendInfo.stt && navigator.mediaDevices && window.MediaRecorder) return 'server';
    if (SpeechRec) return 'web';
    return 'none';
  }

  function refreshVoiceMode() {
    var m = currentVoiceMode();
    vMode.textContent = m === 'server' ? '인식: AI 서버' + (backendInfo.gpu ? '(' + backendInfo.gpu + ')' : '') :
      m === 'web' ? '인식: 브라우저 음성인식' : '인식: 직접 입력';
  }

  function setVoiceState(st) {
    voice.state = st;
    vBtn.setAttribute('aria-pressed', st === 'listening' ? 'true' : 'false');
    vBtn.disabled = st === 'transcribing' || st === 'starting';
    vBtnText.textContent = st === 'listening' ? '듣는 중… (눌러서 완료)' :
      st === 'transcribing' ? '인식하는 중…' : '음성으로 조건 말하기';
    vListening.hidden = !(st === 'listening' || st === 'transcribing');
    if (st === 'listening') vInterim.textContent = '듣고 있어요… 말씀해 주세요';
    if (st === 'transcribing') vInterim.textContent = 'AI 서버에서 음성을 인식하는 중이에요…';
  }

  function showConfirm(text, note, isErr) {
    vConfirm.hidden = false;
    vText.value = text || '';
    vNote.textContent = note || '';
    vNote.className = 'voice__note' + (isErr ? ' voice__note--err' : '');
    vText.focus();
  }

  function closeConfirm() { vConfirm.hidden = true; }

  // 인식 실패·미지원 시에도 같은 확인창에서 직접 입력하면 동일하게 해석한다
  function typedFallback(msg, isErr) { showConfirm('', msg, isErr); }

  var SR_ERRORS = {
    'not-allowed': '마이크 권한이 거부됐어요. 주소창의 권한 설정에서 허용해 주세요.',
    'service-not-allowed': '이 환경에서는 음성 인식을 사용할 수 없어요.',
    'no-speech': '음성이 들리지 않았어요. 다시 눌러 말씀해 주세요.',
    'audio-capture': '마이크를 찾을 수 없어요.',
    'network': '음성 인식 서비스에 연결하지 못했어요.'
  };

  function startWebSpeech() {
    var rec = new SpeechRec();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    var finalText = '', failed = false;
    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      var shown = (finalText + interim).trim();
      if (shown) vInterim.textContent = shown;
    };
    rec.onerror = function (e) {
      var code = e && e.error;
      if (code === 'aborted') return;
      failed = true;
      voice.stopFn = null;
      setVoiceState('idle');
      typedFallback((SR_ERRORS[code] || '음성 인식 중 문제가 생겼어요.') + ' 문장을 직접 입력해도 같은 방식으로 해석해요.', true);
    };
    rec.onend = function () {
      voice.stopFn = null;
      if (failed) return;
      setVoiceState('idle');
      var text = finalText.trim();
      if (text) showConfirm(text, '인식이 틀렸다면 고쳐 주세요. 지명이 가장 자주 틀려요.');
      else typedFallback('음성이 들리지 않았어요. 다시 말하거나 직접 입력해 주세요.', true);
    };
    voice.stopFn = function () { try { rec.stop(); } catch (e) { /* 이미 종료됨 */ } };
    try {
      rec.start();
      setVoiceState('listening');
    } catch (e) {
      voice.stopFn = null;
      setVoiceState('idle');
      typedFallback('음성 인식을 시작하지 못했어요. 문장을 직접 입력해 주세요.', true);
    }
  }

  function pickRecorderMime() {
    var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < list.length; i++) {
      if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return '';
  }

  // 서버 인식 경로: 브라우저에서 녹음 → /stt → 확인창. 오디오 Blob은 인식 직후 버린다
  function startServerRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = pickRecorderMime();
      var rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      var chunks = [], timer = null;
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        clearTimeout(timer);
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        chunks = [];
        voice.stopFn = null;
        setVoiceState('transcribing');
        backendTranscribe(blob).then(function (text) {
          blob = null;
          setVoiceState('idle');
          if (text.trim()) showConfirm(text.trim(), 'AI 서버가 인식한 결과예요. 틀린 부분은 고쳐 주세요.');
          else typedFallback('음성이 들리지 않았어요. 다시 말하거나 직접 입력해 주세요.', true);
        }, function () {
          blob = null;
          backendInfo.ok = false; // 이후 30초간은 브라우저 음성인식으로 자동 전환
          backendInfo.at = Date.now();
          refreshVoiceMode();
          setVoiceState('idle');
          typedFallback('AI 서버 음성 인식에 실패했어요. 다음부터는 브라우저 음성인식을 써요. 다시 말하거나 직접 입력해 주세요.', true);
        });
      };
      voice.stopFn = function () { if (rec.state !== 'inactive') rec.stop(); };
      timer = setTimeout(voice.stopFn, 15000); // 최대 15초
      rec.start();
      setVoiceState('listening');
    }).catch(function (e) {
      setVoiceState('idle');
      typedFallback(e && e.name === 'NotAllowedError' ? SR_ERRORS['not-allowed'] : '마이크를 사용할 수 없어요. 문장을 직접 입력해 주세요.', true);
    });
  }

  function startVoice() {
    closeConfirm();
    var mode = currentVoiceMode();
    if (mode === 'server') { setVoiceState('starting'); startServerRecording(); }
    else if (mode === 'web') startWebSpeech();
    else typedFallback('이 브라우저는 음성 인식을 지원하지 않아요. 문장을 직접 입력해도 같은 방식으로 해석해요.', false);
  }

  vBtn.addEventListener('click', function () {
    if (voice.state === 'listening') { if (voice.stopFn) voice.stopFn(); return; }
    if (voice.state !== 'idle') return;
    setVoiceState('starting');
    backendProbe().then(function () {
      refreshVoiceMode();
      setVoiceState('idle');
      startVoice();
    });
  });
  document.getElementById('voice-stop').addEventListener('click', function () { if (voice.stopFn) voice.stopFn(); });
  document.getElementById('voice-retry').addEventListener('click', function () { vBtn.click(); });
  document.getElementById('voice-cancel').addEventListener('click', closeConfirm);

  function submitVoiceText() {
    var text = vText.value.trim();
    if (!text) { vNote.textContent = '문장을 입력해 주세요.'; vNote.className = 'voice__note voice__note--err'; return; }
    vApply.disabled = true;
    parseIntentAsync(text).then(function (res) {
      applyIntent(res);
      closeConfirm();
    }).then(function () { vApply.disabled = false; }, function () { vApply.disabled = false; });
  }
  vApply.addEventListener('click', submitVoiceText);
  vText.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitVoiceText(); }
    else if (e.key === 'Escape') closeConfirm();
  });

  refreshVoiceMode();
  if (BACKEND_URL) backendProbe().then(refreshVoiceMode);

  /* ───────────── API 키 / 모드 표시 ───────────── */

  function getKey() {
    try { return (sessionStorage.getItem(KEY_STORE) || '').trim(); } catch (e) { return ''; }
  }

  function refreshMode() {
    var live = !!getKey();
    modeBadge.textContent = live ? 'Claude 연결됨' : '키 없음 · 로컬 데모 분석';
    modeBadge.className = 'mode-badge ' + (live ? 'mode-badge--live' : 'mode-badge--demo');
  }

  apiKeyInput.value = getKey();
  apiKeyInput.addEventListener('input', function () {
    try {
      var v = apiKeyInput.value.trim();
      if (v) sessionStorage.setItem(KEY_STORE, v); else sessionStorage.removeItem(KEY_STORE);
    } catch (e) { /* 저장소 사용 불가 시 무시 */ }
    refreshMode();
  });

  /* ───────────── 공통 유틸 ───────────── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // 모델 출력은 항상 textContent로만 삽입 (XSS 방지)
    return n;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // 받침 유무에 따라 조사 선택 (한글이 아니면 둘 다 표기)
  function josa(word, withBatchim, without) {
    var code = String(word).charCodeAt(String(word).length - 1);
    if (code < 0xAC00 || code > 0xD7A3) return withBatchim + '(' + without + ')';
    return (code - 0xAC00) % 28 !== 0 ? withBatchim : without;
  }

  function stats(times) {
    var min = Math.min.apply(null, times);
    var max = Math.max.apply(null, times);
    var avg = times.reduce(function (a, b) { return a + b; }, 0) / times.length;
    var sd = Math.sqrt(times.reduce(function (a, b) { return a + (b - avg) * (b - avg); }, 0) / times.length);
    // 공평성 점수: 평균 대비 표준편차가 클수록 감점 (편차 0분 = 100점)
    var fairness = clamp(Math.round(100 - (sd / avg) * 200), 0, 100);
    return { min: min, max: max, avg: Math.round(avg), spread: max - min, fairness: fairness };
  }

  /* ───────────── 지오코딩(Nominatim) · 주변 장소(Nominatim) — 둘 다 무료, API 키 불필요 ───────────── */

  var NOMINATIM = 'https://nominatim.openstreetmap.org';
  var GEO_CACHE_KEY = 'moyeora.geo.v1';
  var geoCache = loadGeoCache();
  var lastNominatimAt = 0;
  var nominatimChain = Promise.resolve();

  function loadGeoCache() {
    try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveGeoCache() {
    try {
      if (Object.keys(geoCache).length > 300) geoCache = {}; // 무한정 커지지 않게
      localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache));
    } catch (e) { /* 저장소 사용 불가 시 무시 */ }
  }

  function fetchJson(url, ms, opts) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    var o = opts || {};
    o.signal = ctrl.signal;
    return fetch(url, o).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  // Nominatim 이용 정책: 초당 1회 이하 → 모든 요청을 직렬 큐에 넣고 최소 1.1초 간격을 둔다
  function nominatimGet(path) {
    var run = nominatimChain.then(function () {
      var wait = Math.max(0, lastNominatimAt + 1100 - Date.now());
      return new Promise(function (r) { setTimeout(r, wait); });
    }).then(function () {
      lastNominatimAt = Date.now();
      return fetchJson(NOMINATIM + path, 12000);
    });
    nominatimChain = run.catch(function () { /* 한 요청의 실패가 큐를 막지 않게 */ });
    return run;
  }

  // 장소 문자열 → { lat, lng, name } 또는 null. 한국 내 결과로 한정, 결과는 localStorage에 캐시
  function geocode(query, bias) {
    var key = query.trim().toLowerCase() + '|' + (bias ? bias.lat.toFixed(1) + ',' + bias.lng.toFixed(1) : '');
    if (geoCache[key]) return Promise.resolve(geoCache[key]);
    var path = '/search?format=jsonv2&limit=1&countrycodes=kr&accept-language=ko&q=' + encodeURIComponent(query);
    if (bias) path += '&viewbox=' + (bias.lng - 0.6) + ',' + (bias.lat + 0.5) + ',' + (bias.lng + 0.6) + ',' + (bias.lat - 0.5);
    return nominatimGet(path).then(function (arr) {
      if (!Array.isArray(arr) || !arr.length) return null;
      var h = arr[0], c = validCoord(h.lat, h.lon);
      if (!c) return null;
      var out = { lat: c.lat, lng: c.lng, name: String(h.name || String(h.display_name || '').split(',')[0] || query) };
      geoCache[key] = out;
      saveGeoCache();
      return out;
    });
  }

  function reverseName(c) {
    return nominatimGet('/reverse?format=jsonv2&zoom=16&accept-language=ko&lat=' + c.lat + '&lon=' + c.lng).then(function (d) {
      var a = (d && d.address) || {};
      return a.suburb || a.neighbourhood || a.quarter || a.town || a.village || a.city_district || a.city || a.county || '중간 지점';
    }).catch(function () { return '중간 지점'; });
  }

  var CUISINE_KO = {
    korean: '한식', japanese: '일식', chinese: '중식', italian: '이탈리안', pizza: '피자', burger: '버거',
    steak_house: '스테이크', barbecue: '고기구이', korean_bbq: '고기구이', seafood: '해산물', noodle: '면요리',
    ramen: '라멘', sushi: '스시', chicken: '치킨', coffee_shop: '커피', dessert: '디저트', bakery: '베이커리',
    sandwich: '샌드위치', thai: '태국', vietnamese: '베트남', indian: '인도', french: '프랑스', regional: '향토음식',
    pasta: '파스타', brunch: '브런치', ice_cream: '아이스크림', beef: '소고기', pork: '돼지고기'
  };
  var TYPE_KO = {
    restaurant: '음식점', cafe: '카페', bar: '바', pub: '펍·주점', fast_food: '패스트푸드', food_court: '푸드코트',
    park: '공원', garden: '정원', nature_reserve: '자연공원', recreation_ground: '휴게공원', museum: '박물관', gallery: '갤러리',
    cinema: '영화관', theatre: '극장', arts_centre: '문화예술센터', library: '도서관',
    study_centre: '독서실·스터디룸', coworking: '공유오피스'
  };
  var KIND_ICON = { '식당': '🍽', '카페': '☕', '공원': '🌳', '문화': '🎨', '스터디': '📚', '기타': '📍' };
  var MAX_SPOTS = 9;

  // 필터 버튼 묶음: 식당/카페/공원 외에는 '스터디·문화'(etc)로 모은다
  function kindBucket(kind) { return kind === '식당' || kind === '카페' || kind === '공원' ? kind : 'etc'; }

  function kindOfType(type) {
    if (type === 'cafe') return '카페';
    if (/^(restaurant|fast_food|bar|pub|food_court)$/.test(type)) return '식당';
    if (/^(park|garden|nature_reserve|recreation_ground)$/.test(type)) return '공원';
    if (/^(museum|gallery|cinema|theatre|arts_centre)$/.test(type)) return '문화';
    if (/^(library|study_centre|coworking)$/.test(type)) return '스터디';
    return '기타';
  }

  // 이름을 먼저 본다: 스터디카페는 OSM 에서 amenity=cafe 로 오는 경우가 많아 type 만으로는 '카페'가 된다
  function kindOfPlace(type, name) {
    var nm = String(name || '');
    if (/스터디|독서실|코워킹|공유\s*오피스/.test(nm)) return '스터디';
    var k = kindOfType(type);
    if (k !== '기타') return k;
    if (/공원|산책로|둘레길|수목원|숲길|녹지/.test(nm)) return '공원'; // landuse/leisure 등으로 태깅된 공원
    if (/미술관|박물관|갤러리|영화관|극장|전시관/.test(nm)) return '문화';
    return '기타';
  }

  // AI가 준 분류 문구로 종류 추정 (kind 값이 없거나 이상할 때)
  function guessKind(text) {
    if (/스터디|도서관|독서/.test(text)) return '스터디';
    if (/카페|커피|디저트|베이커리|브런치/.test(text)) return '카페';
    if (/공원|산책|숲|정원|하천|호수|둘레길/.test(text)) return '공원';
    if (/박물관|미술|전시|영화|극장|공연|갤러리|문화/.test(text)) return '문화';
    if (/식당|한식|일식|중식|양식|고기|구이|주점|이자카야|술|국밥|면|분식|치킨|횟집|레스토랑/.test(text)) return '식당';
    return '기타';
  }

  /* ── 선택한 조건 → 장소 검색어 · 매칭 점수 ──
     primary: 목적/종류 조건(스터디·공원·문화·식사·카페). 선택하면 해당 종류가 상위에 오고 무관한 종류는 감점.
     strict : 종류만 맞아서는 안 되고 이름/태그가 맞아야 가산(고기·이자카야·산책로 같은 세부 테마).
     queries: Nominatim 검색어(영어 단어는 종류 검색, 한글은 이름 검색). search: 지도앱에서 직접 찾을 때 쓸 검색어. */
  var SPOT_INTENTS = [
    { key: 'study', label: '스터디', primary: true, cond: /스터디|공부|작업|독서|노트북|코워킹/, kinds: ['스터디'],
      queries: ['스터디카페', 'library', '독서실'], search: '스터디카페', weight: 70,
      name: /스터디|독서실|도서관|북카페|코워킹|공유\s*오피스|라이브러리/i },
    { key: 'park', label: '공원·산책', primary: true, cond: /공원|산책|피크닉|야외|자연|숲|녹지|등산/, kinds: ['공원'],
      queries: ['park', '공원'], search: '공원', weight: 70, name: /공원|산책|둘레길|숲|정원|녹지|수목원|천변|하천변/ },
    { key: 'culture', label: '문화·전시', primary: true, cond: /전시|문화|영화|공연|박물관|미술|갤러리/, kinds: ['문화'],
      queries: ['museum', '미술관', 'cinema'], search: '미술관 전시', weight: 70, name: /박물관|미술관|갤러리|전시|영화관|극장|문화|아트/ },
    { key: 'meal', label: '식사', primary: true, cond: /식사|밥|점심|저녁|맛집|회식|고기|구이|한식|양식|파스타|국밥|이자카야|술집|식당/, kinds: ['식당'],
      queries: ['restaurant'], search: '맛집', weight: 55, name: /식당|국밥|한식|고기|구이|갈비|삼겹|곱창|파스타|스테이크|초밥|라멘|칼국수|분식|족발|보쌈|횟집/ },
    { key: 'cafe', label: '카페', primary: true, cond: /카페|커피|디저트|베이커리|브런치/, kinds: ['카페'],
      queries: ['cafe', '디저트'], search: '카페', weight: 55, name: /카페|커피|디저트|베이커리|브런치|로스터스|cafe|coffee/i },
    { key: 'meat', label: '고기·구이', strict: true, cond: /고기|구이|삼겹|갈비|곱창/, kinds: ['식당'],
      queries: ['고깃집'], search: '고깃집', weight: 30, name: /고기|구이|갈비|삼겹|곱창|숯불|정육|바베큐/ },
    { key: 'izakaya', label: '이자카야·술집', strict: true, cond: /이자카야|술집|맥주|호프|와인|한잔/, kinds: ['식당'],
      queries: ['bar', '이자카야'], search: '이자카야', weight: 35, types: /^(bar|pub)$/, name: /이자카야|술집|포차|호프|주점|와인|맥주|bar|pub/i },
    { key: 'walk', label: '산책로', strict: true, cond: /산책|둘레길|트레킹/, kinds: ['공원'],
      queries: ['산책로', '둘레길'], search: '산책로', weight: 25, name: /산책|둘레길|트레일|숲길|하천|천변/ }
  ];

  // 종류와 무관하게 점수만 올리는 속성 조건. tag 는 OSM 태그로 직접 확인할 수 있을 때만 적용된다.
  function isLateOpen(hours) {
    if (!hours) return false;
    if (/24\/7/.test(hours)) return true;
    var re = /-(\d{1,2}):\d{2}/g, m;
    while ((m = re.exec(hours)) !== null) { var h = Number(m[1]); if (h >= 22 || h <= 5) return true; }
    return false;
  }
  var SPOT_MODS = [
    { label: '조용한', cond: /조용|한적|차분|고요/, name: /북카페|서점|도서관|티룸|찻집|한옥|조용/, weight: 20 },
    { label: '분위기', cond: /분위기|감성|데이트|뷰|루프탑|프라이빗/, name: /루프탑|뷰|감성|브런치|와인|다이닝|라운지|테라스|정원/, weight: 20 },
    { label: '가성비', cond: /가성비|저렴|합리적/, name: /분식|국밥|김밥|백반|칼국수|국수|뷔페|무한|1인|시장/, weight: 15 },
    { label: '심야·24시', cond: /24\s*시|밤샘|새벽|심야|늦게까지|2[23]\s*시|자정/, name: /24시|야식|포차/, weight: 30,
      tag: function (t) { return isLateOpen(t.opening_hours); } },
    { label: '휠체어', cond: /휠체어|단차|배리어프리/, weight: 35, tag: function (t) { return t.wheelchair === 'yes'; } },
    { label: '반려동물', cond: /반려|애견|강아지|펫/, name: /펫|애견|도그/, weight: 35, tag: function (t) { return t.dog === 'yes' || t.dog === 'leashed'; } },
    { label: 'Wi-Fi', cond: /콘센트|와이파이|wi-?fi|충전|플러그/i, name: /스터디|북카페|코워킹|라이브러리/, weight: 25,
      tag: function (t) { return /^(wlan|wifi|yes)$/.test(t.internet_access || ''); } },
    { label: '룸·단체', cond: /룸|단체석|단체|예약/, name: /룸|프라이빗|단체|한정식|파티|연회/, weight: 15 },
    { label: '빠른 식사', cond: /빠른|웨이팅|빨리|속성/, name: /분식|국밥|김밥|덮밥|국수|버거/, weight: 15,
      tag: function (t) { return t._type === 'fast_food'; } }
  ];

  function buildSpotProfile(cond) {
    var c = String(cond || '').replace(/스터디\s*카페/g, '스터디'); // "스터디카페"는 카페 조건이 아니라 스터디 조건
    var intents = SPOT_INTENTS.filter(function (it) { return it.cond.test(c); });
    var mods = SPOT_MODS.filter(function (m) { return m.cond.test(c); });
    return {
      intents: intents,
      mods: mods,
      primary: intents.filter(function (it) { return it.primary; }),
      active: intents.length + mods.length > 0
    };
  }

  // 한 장소가 한 목적/테마 조건에 맞는가
  function intentHit(it, p, t) {
    var text = p.name + ' ' + (p.category || '');
    if (it.name && it.name.test(text)) return true;
    if (t && t._type && it.types && it.types.test(t._type)) return true;
    return !it.strict && it.kinds.indexOf(p.kind) !== -1;
  }

  // 조건 일치 점수(+이유). 선택한 목적과 무관한 종류는 -30 해서 '최적 3곳'에서 밀려나게 한다
  function matchSpot(p, t, profile) {
    var text = p.name + ' ' + (p.category || '');
    var score = 0, why = [], primaryHit = false;
    profile.intents.forEach(function (it) {
      if (!intentHit(it, p, t)) return;
      score += it.weight;
      why.push(it.label);
      if (it.primary) primaryHit = true;
    });
    profile.mods.forEach(function (m) {
      if ((m.name && m.name.test(text)) || (m.tag && t && m.tag(t))) { score += m.weight; why.push(m.label); }
    });
    if (profile.primary.length && !primaryHit) score -= 30;
    return { score: score, why: why };
  }

  function osmPlace(t) {
    var cuisines = String(t.cuisine || '').split(/[;,]/).map(function (x) { return x.trim(); }).filter(Boolean);
    var ko = cuisines.map(function (c) { return CUISINE_KO[c]; }).filter(Boolean).slice(0, 2);
    var addr = t['addr:full'] || ((t['addr:street'] || '') + ' ' + (t['addr:housenumber'] || '')).trim();
    var name = String(t['name:ko'] || t.name).slice(0, 60);
    var kind = kindOfPlace(t._type, name);
    return {
      name: name,
      category: ko.length ? ko.join('·') : (kind === '스터디' && t._type === 'cafe' ? '스터디카페' : (TYPE_KO[t._type] || (kind !== '기타' ? kind : '장소'))),
      kind: kind,
      address: String(addr).slice(0, 120),
      signature: '',
      coord: t._coord || null
    };
  }

  // 리뷰 데이터가 없는 무료 지도(OSM)에서 '정보가 풍부한 곳'을 인기 대용 점수로 쓴다 (조건 일치 점수와 합산)
  function osmBaseScore(t) {
    var s = Object.keys(t).length + (t.wikidata ? 5 : 0) + (t.website || t['contact:website'] ? 3 : 0) + (t.opening_hours ? 1 : 0);
    if (t['addr:street']) s += 2;
    if (/[가-힣]/.test(t['name:ko'] || t.name)) s += 3; // 한글 이름 우선
    if (t._type === 'fast_food') s -= 3;
    return s;
  }

  function buildCandidates(elements) {
    var seen = {}, list = [];
    (elements || []).forEach(function (e) {
      var t = e && e.tags;
      if (!t || !t.name) return;
      var key = String(t.name).replace(/\s+/g, '').toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      list.push({ t: t, p: osmPlace(t) });
    });
    return list;
  }

  // 조건 일치 점수 + 정보 점수로 정렬하고, 선택한 종류는 상한을 넓혀 최적 3곳이 조건에 맞는 곳으로 채워지게 한다
  function pickOsmPlaces(cands, profile, origin) {
    var scored = cands.map(function (c) {
      var m = matchSpot(c.p, c.t, profile);
      c.p.pop = osmBaseScore(c.t) + m.score;
      c.p.why = m.why;
      return c.p;
    }).sort(function (a, b) { return b.pop - a.pop; });

    var caps = { '식당': 3, '카페': 3, '공원': 2, '문화': 1, '스터디': 1, '기타': 0 }, used = {}, out = [];
    if (profile.primary.length) {
      var wanted = {};
      profile.primary.forEach(function (it) { it.kinds.forEach(function (k) { wanted[k] = true; }); });
      Object.keys(caps).forEach(function (k) { caps[k] = wanted[k] ? 6 : Math.min(caps[k], 2); });
    }
    scored.forEach(function (p) {
      used[p.kind] = used[p.kind] || 0;
      if (used[p.kind] >= (caps[p.kind] || 0)) return;
      used[p.kind]++;
      if (origin && p.coord) p.dist = Math.round(distKm(p.coord, origin) * 1000);
      out.push(p);
    });
    return out.slice(0, MAX_SPOTS);
  }

  // 조건별 검색어 계획. 조건이 없거나 속성 조건뿐이면 기본(식당·카페·공원)으로 찾는다.
  function planQueries(profile) {
    var qs = [];
    function add(q) { if (qs.indexOf(q) === -1) qs.push(q); }
    if (!profile.intents.length) { ['restaurant', 'cafe', 'park'].forEach(add); }
    else {
      profile.intents.slice().sort(function (a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0); })
        .forEach(function (it) { it.queries.forEach(add); });
    }
    return qs.slice(0, 8); // Nominatim 은 초당 1회 → 최대 8회(약 9초)
  }

  // 조건에 맞는 장소가 적을 때 사용자가 직접 찾아볼 수 있도록 안내할 항목
  function placeHints(cands, profile) {
    return profile.primary.map(function (it) {
      var count = cands.filter(function (c) { return intentHit(it, c.p, c.t); }).length;
      return { label: it.label, search: it.search, count: count };
    }).filter(function (h) { return h.count < 3; });
  }

  // 주변 스팟: Nominatim 구역 한정(bounded) 검색으로 OSM 에 등록된 실제 장소를 가져온다 (키 불필요, 좌표·도로명주소 포함).
  // 선택한 조건이 검색어를 직접 결정한다. 조건에 맞는 장소가 부족하면 반경을 1km → 2.5km 로 넓혀 한 번 더 찾는다.
  function nominatimPlaces(coord, cond) {
    var profile = buildSpotProfile(cond);
    var elements = [], fails = 0, total = 0;

    function acceptable(p) {
      var name = p.name || (p.namedetails && p.namedetails.name) || '';
      if (!name) return false;
      if (p.category === 'highway') {
        return /^(footway|path|pedestrian|cycleway|track)$/.test(p.type) && /산책|둘레길|숲길|공원|트레일/.test(name);
      }
      if (/^(place|boundary|railway|waterway|man_made|route|aeroway|emergency)$/.test(p.category)) return false;
      return kindOfPlace(p.type, name) !== '기타';
    }

    function runQueries(queries, rLat, rLng) {
      var viewbox = (coord.lng - rLng) + ',' + (coord.lat + rLat) + ',' + (coord.lng + rLng) + ',' + (coord.lat - rLat);
      return queries.reduce(function (chain, q) {
        return chain.then(function () {
          total++;
          return nominatimGet('/search?format=jsonv2&limit=20&addressdetails=1&extratags=1&namedetails=1&accept-language=ko&countrycodes=kr&bounded=1&viewbox=' +
            viewbox + '&q=' + encodeURIComponent(q)).then(function (arr) {
            (Array.isArray(arr) ? arr : []).forEach(function (p) {
              if (!acceptable(p)) return;
              var a = p.address || {}, nd = p.namedetails || {};
              var tags = {};
              Object.keys(p.extratags || {}).forEach(function (k) { tags[k] = p.extratags[k]; });
              tags.name = p.name || nd.name;
              if (nd['name:ko']) tags['name:ko'] = nd['name:ko'];
              tags._type = p.type;
              tags._coord = validCoord(p.lat, p.lon);
              if (a.road) tags['addr:street'] = a.road;
              if (a.house_number) tags['addr:housenumber'] = a.house_number;
              elements.push({ tags: tags });
            });
          }).catch(function () { fails++; }); // 한 검색어가 실패해도 나머지로 계속
        });
      }, Promise.resolve());
    }

    return runQueries(planQueries(profile), 0.009, 0.011).then(function () { // 반경 약 1km
      var cands = buildCandidates(elements);
      // 목적 조건에 맞는 장소가 부족하면 그 조건의 검색어만 반경을 넓혀 다시 찾는다
      var weak = profile.primary.filter(function (it) {
        return cands.filter(function (c) { return intentHit(it, c.p, c.t); }).length < 2;
      });
      if (!weak.length) return null;
      var wide = [];
      weak.forEach(function (it) { it.queries.slice(0, 2).forEach(function (q) { if (wide.indexOf(q) === -1) wide.push(q); }); });
      return runQueries(wide.slice(0, 4), 0.022, 0.027); // 반경 약 2.5km
    }).then(function () {
      if (fails === total) throw new Error('places unavailable');
      var cands = buildCandidates(elements);
      return {
        list: pickOsmPlaces(cands, profile, coord),
        hints: placeHints(cands, profile),
        profileActive: profile.active
      };
    });
  }

  // Claude 가 준 스팟에도 같은 조건 점수를 적용한다 (AI 가 정한 유명도 순서는 기본 점수로 유지)
  function applyConditionMatch(view, cond) {
    var profile = buildSpotProfile(cond);
    view.placesProfile = profile.active;
    view.places.forEach(function (p, i) {
      var m = matchSpot(p, null, profile);
      p.why = m.why;
      p.pop = (100 - i) + m.score;
    });
    view.placesHints = placeHints(view.places.map(function (p) { return { p: p, t: null }; }), profile);
  }

  /* ───────────── 로컬 추정 엔진 (키 없음 / API 실패 시) ───────────── */

  var STATIONS = [
    ['강남', 37.4979, 127.0276, '2호선·신분당선'], ['홍대입구', 37.5572, 126.9245, '2호선·공항철도·경의중앙선'],
    ['잠실', 37.5133, 127.1001, '2호선·8호선'], ['왕십리', 37.5612, 127.0371, '2호선·5호선·경의중앙선·수인분당선'],
    ['사당', 37.4765, 126.9816, '2호선·4호선'], ['신도림', 37.5088, 126.8913, '1호선·2호선'],
    ['건대입구', 37.5404, 127.0702, '2호선·7호선'], ['신촌', 37.5551, 126.9367, '2호선'],
    ['합정', 37.5496, 126.9139, '2호선·6호선'], ['서울', 37.5547, 126.9707, '1호선·4호선·공항철도'],
    ['종로3가', 37.5704, 126.9921, '1호선·3호선·5호선'], ['고속터미널', 37.5049, 127.0049, '3호선·7호선·9호선'],
    ['교대', 37.4934, 127.0146, '2호선·3호선'], ['선릉', 37.5045, 127.0490, '2호선·수인분당선'],
    ['을지로3가', 37.5663, 126.9926, '2호선·3호선'], ['성수', 37.5446, 127.0559, '2호선'],
    ['여의도', 37.5216, 126.9243, '5호선·9호선'], ['노원', 37.6553, 127.0613, '4호선·7호선'],
    ['판교', 37.3948, 127.1112, '신분당선·경강선'], ['구로디지털단지', 37.4851, 126.9015, '2호선'],
    ['이태원', 37.5345, 126.9946, '6호선'], ['혜화', 37.5822, 127.0018, '4호선'],
    ['천호', 37.5385, 127.1236, '5호선·8호선'], ['상봉', 37.5966, 127.0855, '7호선·경의중앙선·경춘선'],
    ['김포공항', 37.5625, 126.8010, '5호선·9호선·공항철도'], ['수서', 37.4874, 127.1017, '3호선·수인분당선·SRT'],
    ['서울대입구', 37.4813, 126.9527, '2호선'], ['신림', 37.4843, 126.9297, '2호선·신림선'],
    ['강변', 37.5351, 127.0946, '2호선'], ['공덕', 37.5440, 126.9516, '5호선·6호선·공항철도·경의중앙선'],
    // 전국 거점역 (수도권 밖 · 신도시 · KTX/SRT 정차역)
    ['용산', 37.5299, 126.9648, '1호선·KTX'], ['영등포', 37.5155, 126.9076, '1호선·5호선'],
    ['수원', 37.2661, 127.0001, '1호선·수인분당선·KTX'], ['안양', 37.4017, 126.9227, '1호선'],
    ['광명', 37.4166, 126.8844, 'KTX'], ['모란', 37.4320, 127.1291, '8호선·수인분당선'],
    ['부천', 37.4845, 126.7826, '1호선'], ['인천', 37.4757, 126.6165, '1호선'],
    ['의정부', 37.7385, 127.0460, '1호선'], ['대화', 37.6760, 126.7473, '3호선'],
    ['천안아산', 36.7945, 127.1046, 'KTX'], ['오송', 36.6205, 127.3276, 'KTX'],
    ['대전', 36.3326, 127.4344, 'KTX·1호선'], ['전주', 35.8497, 127.1612, '전라선'],
    ['광주송정', 35.1378, 126.7933, 'KTX'], ['동대구', 35.8795, 128.6286, 'KTX'],
    ['대구', 35.8761, 128.5959, '1호선'], ['울산', 35.5519, 129.1388, 'KTX'],
    ['부산', 35.1150, 129.0403, 'KTX·1호선'], ['서면', 35.1579, 129.0597, '1호선·2호선'],
    ['해운대', 35.1641, 129.1584, '2호선'], ['창원중앙', 35.2316, 128.6811, 'KTX'],
    ['포항', 36.0719, 129.3507, 'KTX'], ['춘천', 37.8847, 127.7167, '경춘선'],
    ['강릉', 37.7646, 128.8993, 'KTX']
  ].map(function (s) { return { name: s[0], label: s[0] + '역', lat: s[1], lng: s[2], line: s[3] }; });

  function stationKey(text) { return String(text).replace(/\s+/g, '').replace(/역$/, ''); }

  function findStation(text, exactOnly) {
    var q = stationKey(text);
    if (q.length < 2) return null;
    var i, s;
    for (i = 0; i < STATIONS.length; i++) if (STATIONS[i].name === q) return STATIONS[i];
    if (exactOnly) return null;
    for (i = 0; i < STATIONS.length; i++) {
      s = STATIONS[i];
      if (q.indexOf(s.name) !== -1 || s.name.indexOf(q) !== -1) return s;
    }
    return null;
  }

  function validCoord(lat, lng) {
    lat = Number(lat); lng = Number(lng);
    // 한반도 일대 범위만 허용 (모델이 엉뚱한 좌표를 주면 마커를 그리지 않음)
    return isFinite(lat) && isFinite(lng) && lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132 ? { lat: lat, lng: lng } : null;
  }

  /* 좌표 우선순위: 내장 역 표(정확 일치) → 모델이 준 좌표 → 내장 역 표(부분 일치) */
  function resolveCoord(text, modelLat, modelLng) {
    var exact = findStation(text, true);
    if (exact) return { lat: exact.lat, lng: exact.lng };
    var m = validCoord(modelLat, modelLng);
    if (m) return m;
    var loose = findStation(text, false);
    return loose ? { lat: loose.lat, lng: loose.lng } : null;
  }

  /* ───────────── 지하철 노선 색상 ───────────── */

  var LINE_COLORS = {
    '1호선': ['#0052A4'], '2호선': ['#00A84D'], '3호선': ['#EF7C1C'], '4호선': ['#00A5DE'],
    '5호선': ['#996CAC'], '6호선': ['#CD7C2F'], '7호선': ['#747F00'], '8호선': ['#E6186C'],
    '9호선': ['#BDB092', '#2b2616'], '신분당선': ['#D4003B'], '수인분당선': ['#F5A200', '#3b2a00'],
    '분당선': ['#F5A200', '#3b2a00'], '경의중앙선': ['#77C4A3', '#0f3a2a'], '공항철도': ['#0090D2'],
    '경춘선': ['#0C8E72'], '경강선': ['#0054A6'], '신림선': ['#6789CA'], '우이신설선': ['#B0CE18', '#2a3300'],
    'SRT': ['#A31F34'], 'GTX-A': ['#9A6292']
  };

  // "2호선·5호선", "2·5호선·경의중앙", "수인분당" 같은 다양한 표기를 노선 목록으로 변환
  function parseLines(text) {
    var seen = {}, out = [];
    String(text || '').split(/[·,\/\s、]+/).filter(Boolean).forEach(function (tok) {
      var m = /^(\d{1,2})(호선)?$/.exec(tok);
      var name = m ? m[1] + '호선' : tok;
      if (!LINE_COLORS[name] && LINE_COLORS[name + '선']) name += '선';
      if (seen[name]) return;
      seen[name] = true;
      var c = LINE_COLORS[name] || ['#64748b'];
      out.push({ name: name, color: c[0], fg: c[1] || '#ffffff' });
    });
    return out.slice(0, 5);
  }

  function distKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // 대중교통 이동시간 단순 추정(직선거리 기반): 시내(~20km)는 지하철/버스, 광역(~100km)은 광역철도, 그 이상은 KTX/고속버스 속도
  function estimateMinutes(a, b) {
    var d = distKm(a, b);
    if (d < 0.4) return 2;
    return Math.round(8 + 2.4 * Math.min(d, 20) + 1.0 * Math.max(0, Math.min(d, 100) - 20) +
      0.55 * Math.max(0, d - 100) + (d > 9 ? 5 : 0));
  }

  var CATEGORY_RULES = [
    { re: /공원|산책|야외|피크닉|자연|등산/, emoji: '🌳', title: '공원 · 산책', desc: '걷고 이야기하기 좋은 야외 공간', kw: ['공원', '산책로', '피크닉'] },
    { re: /스터디|공부|작업|노트북|콘센트|와이파이|독서/, emoji: '📚', title: '스터디 · 작업 공간', desc: '콘센트·와이파이가 있어 오래 머물기 좋은 곳', kw: ['스터디카페', '북카페', '공유오피스'] },
    { re: /전시|문화|영화|공연|박물관|미술|갤러리/, emoji: '🎨', title: '문화 공간', desc: '함께 보고 이야기 나눌 거리가 있는 곳', kw: ['미술관', '전시', '영화관'] },
    { re: /이자카야|술|맥주|호프|와인/, emoji: '🍶', title: '이자카야 · 술집', desc: '2차까지 이어가기 좋은 분위기 있는 술집', kw: ['이자카야', '술집', '와인바'] },
    { re: /조용|대화|차분/, emoji: '🤫', title: '조용히 대화하기 좋은 곳', desc: '목소리 키우지 않아도 되는 룸·칸막이 있는 공간', kw: ['룸식당', '조용한 카페', '한정식'] },
    { re: /분위기|감성|데이트/, emoji: '✨', title: '분위기 좋은 곳', desc: '인테리어와 조명이 좋은 감성 공간', kw: ['분위기 좋은 식당', '브런치', '루프탑'] },
    { re: /카페|디저트|커피|대형/, emoji: '☕', title: '카페 · 디저트', desc: '여럿이 앉기 편한 넓은 카페', kw: ['대형 카페', '디저트 카페'] },
    { re: /고기|구이|삼겹|갈비/, emoji: '🥩', title: '고기 · 구이', desc: '모임 단골 메뉴, 단체석이 넉넉한 곳', kw: ['고깃집', '삼겹살', '갈비'] },
    { re: /단체|회식|동아리/, emoji: '🎉', title: '단체 모임 장소', desc: '여럿이 앉기 편한 넓은 홀·단체석', kw: ['단체석 식당', '회식 장소'] },
    { re: /비즈니스|미팅|룸|예약/, emoji: '💼', title: '미팅하기 좋은 곳', desc: '대화에 집중할 수 있는 룸·예약 가능한 공간', kw: ['룸식당', '한정식', '비즈니스 미팅'] },
    { re: /빠른|웨이팅|1시간|속성/, emoji: '⏱', title: '빠르게 즐기는 곳', desc: '회전이 빨라 대기가 짧은 곳', kw: ['덮밥', '국밥', '쌀국수'] },
    { re: /가성비|저렴|무한/, emoji: '💸', title: '가성비 좋은 곳', desc: '양 많고 가격 부담 없는 곳', kw: ['가성비 맛집', '점심 특선'] }
  ];

  function budgetNote(b) {
    if (b == null) return '예산 제한 없음';
    return '인당 ' + (b / 10000) + '만 원 안쪽';
  }

  /* 무료 로컬 분석: 지오코딩된 출발지 좌표 → 거점역(+필요 시 중간 지점) 후보 → 거리 기반 이동시간 추정.
     payload.origins[i] = { name, place, lat, lng } (좌표는 submit 단계에서 Nominatim으로 이미 해석됨) */
  function localAnalyze(payload) {
    var resolved = payload.origins.map(function (o) { return { o: o, s: { lat: o.lat, lng: o.lng } }; });
    var centroid = {
      lat: resolved.reduce(function (a, r) { return a + r.s.lat; }, 0) / resolved.length,
      lng: resolved.reduce(function (a, r) { return a + r.s.lng; }, 0) / resolved.length
    };

    // 중간 지점 근처 25km 안에 거점역이 하나도 없을 때만(예: 강원·경북 내륙) 무게중심 지점 자체를 후보로 추가(동네 이름은 역지오코딩).
    // 가까운 거점역이 있으면 시골 한가운데 대신 실제 역을 추천하도록 후보를 만들지 않는다.
    var hubNear = STATIONS.some(function (c) { return distKm(c, centroid) <= 25; });
    var extra = hubNear ? Promise.resolve(null) : reverseName(centroid).then(function (n) {
      return { name: n, label: n + ' 일대', lat: centroid.lat, lng: centroid.lng, line: '', centroid: true };
    });

    return extra.then(function (cc) { return buildLocalResult(payload, resolved, cc ? STATIONS.concat([cc]) : STATIONS); });
  }

  function buildLocalResult(payload, resolved, pool0) {
    var limitMatch = /(\d+)\s*분/.exec(payload.conditions);
    var limit = limitMatch ? Number(limitMatch[1]) : null;

    var cands = pool0.map(function (c) {
      var times = resolved.map(function (r) { return estimateMinutes(r.s, c); });
      var st = stats(times);
      // 역이 아닌 '무게중심 후보'는 약간 불리하게 평가해 실제 역을 우선
      return { station: c, times: times, st: st, score: st.avg + 0.9 * (st.spread / 2) + (100 - st.fairness) * 0.05 + (c.centroid ? 15 : 0) };
    });
    var limited = limit ? cands.filter(function (c) { return c.st.max <= limit; }) : cands;
    var pool = limited.length >= 3 ? limited : cands;
    var relaxed = limit && limited.length < 3;
    pool.sort(function (a, b) { return a.score - b.score; });
    var top = pool.slice(0, 3);

    var recs = top.map(function (c, i) {
      return {
        rank: i + 1,
        station: c.station.label,
        line: c.station.line,
        lat: c.station.lat,
        lng: c.station.lng,
        reason: i === 0 ? '평균 이동시간이 짧고 인원 간 시간 차이가 가장 작아요.' :
          '평균 ' + c.st.avg + '분, 최장·최단 차이 ' + c.st.spread + '분으로 균형이 좋아요.',
        travel: resolved.map(function (r, k) { return { person: r.o.name, from: r.o.place, minutes: c.times[k] }; })
      };
    });

    var best = top[0];
    var cats = [];
    CATEGORY_RULES.forEach(function (rule) {
      if (cats.length < 3 && rule.re.test(payload.conditions)) cats.push(rule);
    });
    [
      { emoji: '🍽', title: '식사 · 모임 장소', desc: '단체석이 넉넉하고 메뉴 호불호가 적어요', kw: ['한식', '단체 모임'] },
      { emoji: '☕', title: '카페 · 디저트', desc: '식사 후 이어가기 좋은 카페', kw: ['카페', '디저트'] },
      { emoji: '🌳', title: '공원 · 산책', desc: '식사 후 걷기 좋은 야외 공간', kw: ['공원', '산책로'] }
    ].forEach(function (rule) { if (cats.length < 3) cats.push(rule); });

    return {
      recommendations: recs,
      briefing: [
        { headline: best.station.label + ' — 가장 균형 잡힌 중간 지점', keywords: [resolved.length + '명 모임', '공평성 ' + best.st.fairness + '점'] },
        { headline: '가장 먼 사람도 ' + best.st.max + '분', keywords: ['평균 ' + best.st.avg + '분', '편차 ' + best.st.spread + '분'] },
        { headline: cats[0].title + ' 추천', keywords: cats.slice(0, 2).map(function (c) { return c.title; }).concat([payload.budgetPerPerson == null ? '예산 무제한' : '인당 ' + (payload.budgetPerPerson / 10000) + '만 원']) }
      ],
      categories: cats.map(function (c) { return { emoji: c.emoji, title: c.title, description: c.desc, keywords: c.kw }; }),
      notice: relaxed ? '"' + limit + '분 이내" 조건을 만족하는 역이 3곳 미만이라, 조건을 완화해 가장 가까운 후보를 보여드려요.' : ''
    };
  }

  /* ───────────── Claude API 호출 ───────────── */

  var RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['recommendations', 'briefing', 'categories', 'places'],
    properties: {
      places: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'kind', 'category', 'address', 'signature'],
          properties: {
            name: { type: 'string' },
            kind: { type: 'string', enum: ['식당', '카페', '공원', '문화', '스터디', '기타'] },
            category: { type: 'string' },
            address: { type: 'string' },
            signature: { type: 'string' }
          }
        }
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rank', 'station', 'line', 'lat', 'lng', 'reason', 'travel'],
          properties: {
            rank: { type: 'integer' },
            station: { type: 'string' },
            line: { type: 'string' },
            lat: { type: 'number' },
            lng: { type: 'number' },
            reason: { type: 'string' },
            travel: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['person', 'minutes'],
                properties: { person: { type: 'string' }, minutes: { type: 'integer' } }
              }
            }
          }
        }
      },
      briefing: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['headline', 'keywords'],
          properties: { headline: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } }
        }
      },
      categories: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['emoji', 'title', 'description', 'keywords'],
          properties: {
            emoji: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  };

  var SYSTEM_PROMPT = [
    '너는 대한민국 전국의 대중교통과 지역 명소(식당·카페·공원·스터디카페·문화공간 등)에 밝은 약속 장소 큐레이터야. 사용자가 JSON으로 준 출발지(이름·좌표)·조건·예산을 보고 모두에게 공평한 중간 지점을 추천해.',
    '출발지는 수도권뿐 아니라 전국 어디든 올 수 있고, 각 출발지에는 이미 지오코딩된 lat/lng가 들어 있어. 그 좌표를 신뢰해.',
    '규칙:',
    '- recommendations는 정확히 3개, rank 1~3 순서. 평균 이동시간이 짧고 사람 간 시간 차이가 작은 곳을 우선하고, 조건(이동시간 제한 등)을 지켜. 지하철이 없는 지역이면 기차역·터미널·대표 동네를 후보로 삼아도 돼.',
    '- 각 추천의 travel에는 입력된 모든 사람을 입력 순서대로 한 번씩 넣고, person은 입력의 name(A, B…)을 그대로 써. minutes는 대중교통 기준 문 앞에서 문 앞까지의 현실적인 추정 분(정수).',
    '- station은 "왕십리역"처럼 역/장소 이름, line은 "2호선·5호선·경의중앙선"처럼 "호선"/"선" 이름을 가운뎃점(·)으로 구분한 주요 노선(해당 없으면 빈 문자열).',
    '- 지도 표시용 좌표(WGS84 위도·경도, 소수점 4자리)를 추천 장소마다 lat/lng로 넣어.',
    '- reason은 해당 장소를 추천하는 한 문장.',
    '- briefing은 정확히 3개 항목이고 순서를 지켜: ①핵심 이유(1위를 고른 이유) ②이동시간(수치 포함) ③추천 목적지(조건·예산에 맞는 장소 유형). 각 항목은 headline(25자 이내의 짧은 단문, 줄글 금지)과 keywords(2~3개, 각 8자 이내 키워드)로 구성해.',
    '- categories는 2~3개. 조건·목적·예산에 맞는 목적지 유형(식당, 카페, 공원, 스터디카페, 문화공간 등)을 쓰고, keywords는 지도 검색에 바로 쓸 수 있는 2~4개의 짧은 검색어로 해.',
    '- places는 1위 추천 지역 도보권 안에서 네가 실제로 존재한다고 확신하는 유명한 스팟(식당·카페·공원·스터디카페·문화공간 등) 최대 6곳. 조건에 목적·테마(스터디, 공원·산책, 식사, 카페, 전시 등)가 있으면 places 대부분을 반드시 그 목적에 맞는 장소(스터디→스터디카페·독서실·도서관, 공원→공원·산책로·녹지, 식사→음식점, 카페→카페)로 채우고 목적과 무관한 종류로 채우지 마. 그 안에서 유명도·인기 순으로 나열해. name은 정확한 상호/장소명, kind는 식당|카페|공원|문화|스터디|기타 중 하나, category는 "한식·고기구이" 같은 세부 분류, address는 아는 만큼의 도로명주소(모르면 동 단위까지만), signature는 식당·카페면 대표 메뉴 1~2개, 그 외에는 한 줄 특징. 확신이 없으면 지어내지 말고 개수를 줄이거나 빈 배열로 둬.',
    '- 이동시간은 추정치임을 과장하지 말고, 모든 텍스트는 자연스러운 한국어로 작성해.'
  ].join('\n');

  function callClaude(payload, apiKey) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
        fallbacks: 'default',
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var msg = data && data.error && data.error.message ? data.error.message : 'HTTP ' + res.status;
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }).then(function (data) {
      if (data.stop_reason === 'refusal') throw new Error('모델이 이 요청에 응답하지 않았어요.');
      if (data.stop_reason === 'max_tokens') throw new Error('응답이 길이 제한으로 잘렸어요.');
      var text = (data.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
      return parseResultText(text);
    }).then(function (v) {
      clearTimeout(timer);
      return v;
    }, function (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('요청 시간이 초과됐어요.');
      throw e;
    });
  }

  function parseResultText(text) {
    var t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(t); } catch (e) { /* 아래에서 { } 범위만 재시도 */ }
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* fallthrough */ }
    }
    throw new Error('AI 응답을 JSON으로 해석하지 못했어요.');
  }

  /* 모델/로컬 결과를 같은 구조로 검증·정규화. 공평성 점수는 항상 여기서 계산해 일관성을 보장 */
  function normalize(raw, origins) {
    if (!raw || !Array.isArray(raw.recommendations) || !raw.recommendations.length) {
      throw new Error('추천 결과가 비어 있어요.');
    }
    var recs = raw.recommendations.slice(0, 3).map(function (r, i) {
      if (!r || typeof r.station !== 'string' || !Array.isArray(r.travel)) throw new Error('추천 항목 형식 오류');
      var travel = origins.map(function (o, k) {
        var hit = r.travel.filter(function (t) { return t && t.person === o.name; })[0] || r.travel[k];
        var m = hit ? Number(hit.minutes) : NaN;
        if (!isFinite(m)) throw new Error('이동시간 누락 (' + o.name + ')');
        return { person: o.name, from: o.place, minutes: clamp(Math.round(m), 0, 300) };
      });
      var st = stats(travel.map(function (t) { return t.minutes; }));
      return {
        rank: i + 1,
        station: String(r.station),
        line: String(r.line || ''),
        reason: String(r.reason || ''),
        travel: travel,
        st: st,
        coord: resolveCoord(r.station, r.lat, r.lng)
      };
    });
    // 출발지 좌표는 Nominatim/내장 표에서 이미 해석된 값(o.coord)을 우선 사용
    var originPts = origins.map(function (o) {
      return { name: o.name, place: o.place, coord: o.coord || resolveCoord(o.place, null, null) };
    });
    var briefing = (Array.isArray(raw.briefing) ? raw.briefing : []).slice(0, 3).map(function (b) {
      if (typeof b === 'string') return { headline: b.slice(0, 60), keywords: [] }; // 이전 형식(줄글) 링크 호환
      var kws = b && Array.isArray(b.keywords) ? b.keywords : [];
      return {
        headline: String((b && b.headline) || '').slice(0, 60),
        keywords: kws.map(String).filter(Boolean).slice(0, 3).map(function (k) { return k.slice(0, 16); })
      };
    }).filter(function (b) { return b.headline; });
    var cats = (Array.isArray(raw.categories) ? raw.categories : []).slice(0, 3).map(function (c) {
      return {
        emoji: String(c.emoji || '🍽'),
        title: String(c.title || ''),
        description: String(c.description || ''),
        keywords: (Array.isArray(c.keywords) ? c.keywords : []).map(String).filter(Boolean).slice(0, 4)
      };
    }).filter(function (c) { return c.title; });
    var places = (Array.isArray(raw.places) ? raw.places : []).filter(function (p) {
      return p && typeof p.name === 'string' && p.name.trim();
    }).slice(0, MAX_SPOTS).map(function (p, i) {
      var coord = validCoord(p.lat, p.lng);
      var name = String(p.name).trim().slice(0, 60), category = String(p.category || '').slice(0, 40);
      return {
        name: name,
        category: category,
        kind: KIND_ICON[p.kind] ? p.kind : guessKind(category + ' ' + name),
        address: String(p.address || '').slice(0, 120),
        signature: String(p.signature || '').slice(0, 80),
        coord: coord,
        why: (Array.isArray(p.why) ? p.why : []).map(String).slice(0, 4),
        pop: 100 - i, // AI가 유명도 순으로 나열한 순서를 인기 점수로 사용
        dist: coord && recs[0].coord ? Math.round(distKm(coord, recs[0].coord) * 1000) : undefined
      };
    });
    return {
      recs: recs, origins: originPts, briefing: briefing, cats: cats, places: places,
      placesSource: places.length ? (raw.placesSource || 'ai') : '',
      notice: raw.notice ? String(raw.notice) : ''
    };
  }

  /* ───────────── 렌더링 ───────────── */

  function ringClass(score) {
    return score >= 80 ? 'ring--good' : score >= 60 ? 'ring--mid' : 'ring--low';
  }
  function fairnessText(score) {
    return score >= 80 ? '매우 공평' : score >= 60 ? '보통' : '편차 큼';
  }

  function longestPerson(r) {
    return r.travel.reduce(function (a, b) { return b.minutes > a.minutes ? b : a; });
  }

  // 공평성 점수/편차에 따른 칭찬 메시지 (링 색상 구간 80/60과 동일 기준)
  function praise(r) {
    var s = r.st, far = longestPerson(r);
    if (s.fairness >= 90) return { tone: 'top', text: '🏆 거의 같은 시간에 도착! 공평함의 끝판왕이에요 (편차 ' + s.spread + '분)' };
    if (s.fairness >= 80) return { tone: 'good', text: '👏 모두에게 공평한 위치예요 — 최장·최단 차이 ' + s.spread + '분' };
    if (s.fairness >= 60) return { tone: 'mid', text: '👍 무난하게 균형 잡힌 장소예요 (편차 ' + s.spread + '분)' };
    return { tone: 'low', text: '🙏 ' + far.person + '님이 가장 멀리 와요(' + far.minutes + '분) — 오늘은 가까운 사람이 한턱 쏘기!' };
  }

  function lineBadges(text) {
    var lines = parseLines(text);
    if (!lines.length) return null;
    var wrap = el('div', 'line-badges');
    lines.forEach(function (l) {
      var b = el('span', 'line-badge', l.name);
      b.style.setProperty('--c', l.color);
      b.style.setProperty('--fg', l.fg);
      wrap.appendChild(b);
    });
    return wrap;
  }

  function renderRec(r, globalMax) {
    var card = el('article', 'card rec' + (r.rank === 1 ? ' rec--first' : ''));
    card.title = '클릭하면 지도에서 보여줘요';
    card.addEventListener('click', function (e) { if (!e.target.closest('a,button')) focusRec(r.rank); });

    var p = praise(r);
    card.appendChild(el('div', 'rec__praise rec__praise--' + p.tone, p.text));

    var top = el('div', 'rec__top');
    top.appendChild(el('div', 'rec__rank', r.rank + '위'));
    var name = el('div');
    name.appendChild(el('h3', 'rec__name', r.station));
    var badges = lineBadges(r.line);
    if (badges) name.appendChild(badges);
    top.appendChild(name);

    var score = el('div', 'rec__score');
    var ring = el('div', 'ring ' + ringClass(r.st.fairness));
    ring.style.setProperty('--p', r.st.fairness);
    ring.setAttribute('role', 'img');
    ring.setAttribute('aria-label', '공평성 점수 ' + r.st.fairness + '점, ' + fairnessText(r.st.fairness));
    ring.appendChild(el('b', null, String(r.st.fairness)));
    score.appendChild(ring);
    score.appendChild(el('small', null, '공평성 · ' + fairnessText(r.st.fairness)));
    top.appendChild(score);
    card.appendChild(top);

    if (r.reason) card.appendChild(el('p', 'rec__reason', r.reason));

    var bars = el('div', 'bars');
    r.travel.forEach(function (t) {
      var row = el('div', 'bar' + (t.minutes === r.st.max && r.st.spread > 0 ? ' bar--max' : ''));
      row.appendChild(el('span', 'bar__who', t.person));
      var track = el('div', 'bar__track');
      var fill = el('div', 'bar__fill');
      fill.dataset.w = String(Math.max(3, (t.minutes / globalMax) * 100));
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'bar__min', t.minutes + '분'));
      row.appendChild(el('span', 'bar__from', t.from + ' 출발'));
      bars.appendChild(row);
    });
    card.appendChild(bars);

    var s = el('div', 'rec__stats');
    [['평균', r.st.avg + '분'], ['편차', r.st.spread + '분'], ['최장', r.st.max + '분']].forEach(function (p) {
      var d = el('span', null, p[0] + ' ');
      d.appendChild(el('b', null, p[1]));
      s.appendChild(d);
    });
    card.appendChild(s);
    return card;
  }

  // 최적 요약 배너: 1줄 핵심 + 칩 1줄 (이전의 대시보드·브리핑 카드 3장을 대체)
  function renderSummary(view) {
    var box = document.getElementById('summary');
    box.textContent = '';
    var best = view.recs[0], b = view.briefing;
    var main = el('div', 'summary__main');
    main.appendChild(el('span', 'summary__icon', '🎯'));
    main.appendChild(el('strong', 'summary__title', b[0] ? b[0].headline : best.station + ' 추천'));
    main.appendChild(el('span', 'summary__score', '공평성 ' + best.st.fairness + '점'));
    box.appendChild(main);
    var chips = el('div', 'summary__chips');
    if (b[1]) chips.appendChild(el('span', null, '⏱ ' + b[1].headline));
    if (b[2]) chips.appendChild(el('span', null, '🧭 ' + b[2].headline));
    chips.appendChild(el('span', null, '평균 ' + best.st.avg + '분 · 편차 ' + best.st.spread + '분'));
    box.appendChild(chips);
  }

  /* ───────────── 지도 (Leaflet + OpenStreetMap) ───────────── */

  var map = null, mapLayer = null;
  var RANK_ICON_SIZE = { 1: 40, 2: 34, 3: 34 };

  function pinIcon(kind, label, size) {
    var pin = el('div', 'pin pin--' + kind);
    pin.appendChild(el('span', null, label));
    var h = kind === 'origin' ? size : Math.round(size * 1.21); // 45° 회전한 정사각형의 뾰족한 끝 위치
    return L.divIcon({
      className: 'pin-wrap',
      html: pin,
      iconSize: [size, size],
      iconAnchor: kind === 'origin' ? [size / 2, size / 2] : [size / 2, h],
      popupAnchor: [0, kind === 'origin' ? -size / 2 : -h]
    });
  }

  function popupBox(title, rows) {
    var box = el('div');
    box.appendChild(el('div', 'pop__title', title));
    rows.forEach(function (r) {
      var row = el('div', 'pop__row');
      row.appendChild(el('span', null, r[0]));
      row.appendChild(el('b', null, r[1]));
      box.appendChild(row);
    });
    return box;
  }

  var recMarkers = {};

  /* ── 기본 지도(타일) 선택 ──
     공용 타일 서버는 정책 변경으로 예고 없이 막히거나(OSM Referer 정책), 일부 구간만 '데이터 없음' 이미지를 주기도 한다
     (Esri 거리 지도는 한국에서 줌 14 이상이 이 이미지였다). 이런 경우에도 서버는 200 을 돌려줘서 tileerror 로는 못 잡는다.
     그래서 시작할 때 서울 도심 타일 1장을 실제로 받아 용량으로 정상 여부를 판별한다 (정상 약 20~28KB, 자리표시 약 2KB). */
  var BASEMAPS = [
    { id: 'osm', name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' },
    { id: 'osmde', name: 'OSM 한·영', url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png', maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' },
    { id: 'sat', name: '위성(Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
      attribution: 'Tiles &copy; <a href="https://www.esri.com" target="_blank" rel="noopener noreferrer">Esri</a> — Esri, Maxar, Earthstar Geographics' }
  ];
  var BASEMAP_KEY = 'moyeora.basemap';
  var basemapLayers = {}, currentBasemap = '', basemapPicked = false, basemapFailed = false;

  function setBasemap(id) {
    var next = basemapLayers[id];
    if (!next || currentBasemap === id) return;
    if (basemapLayers[currentBasemap]) map.removeLayer(basemapLayers[currentBasemap]);
    next.addTo(map);
    currentBasemap = id;
  }

  // 주의: 판별은 CORS 요청(Origin 헤더 포함)으로 한다. file:// 에서는 OSM 표준 서버가 이 요청에 403 "Access blocked(tile usage policy)"
  // 타일(약 6.7KB)을 돌려주는데, 평범한 <img> 요청은 통과하기도 해서 환경마다 결과가 갈린다. 정책은 예고 없이 바뀌므로 보수적으로
  // 막힌 것으로 보고 다음 후보(OSM 한·영, 위성)로 넘어간다. http(s) 로 호스팅하면 Origin/Referer 가 정상이라 OSM 표준이 선택된다.
  function probeBasemap(bm) {
    var url = bm.url.replace('{z}', '15').replace('{x}', '27948').replace('{y}', '12674'); // 강남역 일대 z15
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 6000);
    return fetch(url, { mode: 'cors', signal: ctrl.signal }).then(function (r) {
      if (!r.ok) throw new Error('bad status');
      return r.blob();
    }).then(function (b) { clearTimeout(timer); return b.size > 8000; }, function () { clearTimeout(timer); return false; });
  }

  function showBasemapNotice() {
    var fb = document.getElementById('map-fallback');
    if (!basemapFailed) return;
    fb.textContent = '지도 타일 서버에서 정상 응답을 받지 못했어요. 지도 오른쪽 위 레이어 버튼에서 다른 지도를 선택해 보세요.';
    fb.hidden = false;
  }

  function chooseBasemap(order) {
    var i = 0;
    function next() {
      if (i >= order.length) { basemapFailed = true; showBasemapNotice(); return null; }
      var bm = order[i++];
      return probeBasemap(bm).then(function (ok) {
        if (basemapPicked) return null; // 그 사이 사용자가 직접 골랐으면 존중
        if (ok) { setBasemap(bm.id); return null; }
        return next();
      });
    }
    return next();
  }

  function initBasemaps() {
    var saved = '';
    try { saved = localStorage.getItem(BASEMAP_KEY) || ''; } catch (e) { /* 저장소 사용 불가 */ }
    var order = BASEMAPS.slice().sort(function (a, b) { return (b.id === saved ? 1 : 0) - (a.id === saved ? 1 : 0); }); // 저장된 선택을 먼저
    var named = {};
    BASEMAPS.forEach(function (bm) {
      basemapLayers[bm.id] = L.tileLayer(bm.url, { maxZoom: bm.maxZoom, attribution: bm.attribution });
      named[bm.name] = basemapLayers[bm.id];
    });
    L.control.layers(named, null, { position: 'topright', collapsed: true }).addTo(map);
    setBasemap(order[0].id); // 우선 하나를 깔아 두고(빈 화면 방지), 실제로 정상인지 확인한 뒤 필요하면 바꾼다
    map.on('baselayerchange', function (e) {
      // 프로그램이 바꾼 경우(currentBasemap 과 이미 일치)는 제외하고, 사용자가 레이어 버튼으로 고른 것만 기억한다
      var picked = BASEMAPS.filter(function (bm) { return basemapLayers[bm.id] === e.layer; })[0];
      if (!picked || picked.id === currentBasemap) return;
      currentBasemap = picked.id;
      basemapPicked = true;
      try { localStorage.setItem(BASEMAP_KEY, picked.id); } catch (err) { /* 무시 */ }
    });
    chooseBasemap(order);
  }

  // 지도는 시작할 때 한 번 만들어 둔다(데스크톱에서는 분석 전에도 오른쪽에 보임). 분석 결과는 renderMap이 레이어에만 그린다
  function ensureMap() {
    if (map || typeof L === 'undefined') return;
    map = L.map(document.getElementById('map-container'), { scrollWheelZoom: false, zoomControl: true });
    initBasemaps();
    mapLayer = L.layerGroup().addTo(map);
    map.setView([36.4, 127.8], 7); // 분석 전 기본 화면: 대한민국 전체
  }

  // 결과 카드를 누르면 해당 역으로 지도를 이동하고 팝업을 연다 (모바일에서는 지도 위치로 스크롤)
  function focusRec(rank) {
    var m = recMarkers[rank];
    if (!map || !m) return;
    if (window.matchMedia('(max-width: 1023px)').matches) {
      document.getElementById('pane-right').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 13), { animate: true });
    m.openPopup();
  }

  function refreshMapSize() {
    if (map) map.invalidateSize();
  }

  function renderMap(view) {
    var box = document.getElementById('map-container');
    var fb = document.getElementById('map-fallback');
    fb.hidden = true;
    showBasemapNotice();
    if (typeof L === 'undefined') {
      fb.textContent = '지도 라이브러리(Leaflet)를 불러오지 못했어요. 네트워크 연결을 확인해 주세요. 분석 결과는 아래에서 그대로 볼 수 있어요.';
      fb.hidden = false;
      return;
    }

    ensureMap();
    mapLayer.clearLayers();
    recMarkers = {};
    document.getElementById('map-empty').hidden = true;
    map.invalidateSize(); // 숨김 상태에서 만들어진 컨테이너 크기를 다시 계산

    var best = view.recs[0];
    var bestMarker = null, points = [];

    // 출발지 → 1위 역 점선 (먼저 그려서 핀 아래에 깔리게)
    if (best.coord) {
      view.origins.forEach(function (o) {
        if (!o.coord) return;
        L.polyline([[o.coord.lat, o.coord.lng], [best.coord.lat, best.coord.lng]],
          { color: '#6366f1', weight: 2, opacity: 0.55, dashArray: '6 7', interactive: false }).addTo(mapLayer);
      });
    }

    view.origins.forEach(function (o) {
      if (!o.coord) return;
      var toBest = best.travel.filter(function (t) { return t.person === o.name; })[0];
      var rows = [['출발지', o.place]];
      if (toBest) rows.push(['1위(' + best.station + ')까지', toBest.minutes + '분']);
      L.marker([o.coord.lat, o.coord.lng], { icon: pinIcon('origin', o.name, 30), title: o.name + ' ' + o.place, zIndexOffset: 100 })
        .bindPopup(popupBox(o.name + ' 출발', rows)).addTo(mapLayer);
      points.push(o.coord);
    });

    view.recs.slice().reverse().forEach(function (r) { // 1위 핀이 가장 위에 오도록 역순으로 추가
      if (!r.coord) return;
      var m = L.marker([r.coord.lat, r.coord.lng], {
        icon: pinIcon('r' + r.rank, String(r.rank), RANK_ICON_SIZE[r.rank] || 34),
        title: r.rank + '위 ' + r.station,
        zIndexOffset: 1000 + (4 - r.rank) * 100
      }).bindPopup(popupBox(r.rank + '위 ' + r.station, [
        ['평균 이동시간', r.st.avg + '분'],
        ['공평성 점수', r.st.fairness + '점'],
        ['이동시간 편차', r.st.spread + '분']
      ])).addTo(mapLayer);
      points.push(r.coord);
      recMarkers[r.rank] = m;
      if (r.rank === 1) bestMarker = m;
    });

    if (!points.length) {
      fb.textContent = '좌표를 확인할 수 있는 위치가 없어 지도를 표시하지 못했어요.';
      fb.hidden = false;
      map.setView([37.5665, 126.978], 11);
      return;
    }

    var bounds;
    if (best.coord) {
      // 1위 역이 지도 정중앙에 오도록, 가장 먼 점까지의 거리를 양방향으로 대칭 확장
      var dLat = 0.012, dLng = 0.012;
      points.forEach(function (c) {
        dLat = Math.max(dLat, Math.abs(c.lat - best.coord.lat));
        dLng = Math.max(dLng, Math.abs(c.lng - best.coord.lng));
      });
      bounds = L.latLngBounds([best.coord.lat - dLat, best.coord.lng - dLng], [best.coord.lat + dLat, best.coord.lng + dLng]);
    } else {
      bounds = L.latLngBounds(points.map(function (c) { return [c.lat, c.lng]; }));
    }
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14, animate: false });
    if (bestMarker) bestMarker.openPopup();
  }

  var BRIEF_META = [
    { icon: '🎯', label: '핵심 이유' },
    { icon: '⏱', label: '이동시간' },
    { icon: '🧭', label: '추천 목적지' }
  ];

  /* ───────────── 실존 추천 가게 카드 ───────────── */

  function searchUrl(provider, text) {
    var q = encodeURIComponent(text);
    return provider === 'naver' ? 'https://map.naver.com/p/search/' + q : 'https://map.kakao.com/?q=' + q;
  }

  function stationShort(label) { return String(label).replace(/\s*일대$/, ''); }

  var spotFilter = 'all', spotSort = 'pop';

  function fmtDist(m) { return m == null ? '' : m < 1000 ? m + 'm' : (m / 1000).toFixed(1) + 'km'; }

  function visibleSpots(view) {
    var list = view.places.filter(function (p) { return spotFilter === 'all' || kindBucket(p.kind) === spotFilter; });
    return list.sort(function (a, b) {
      if (spotSort === 'dist') {
        var da = a.dist == null ? Infinity : a.dist, db = b.dist == null ? Infinity : b.dist; // 거리 모르는 스팟은 뒤로
        if (da !== db) return da < db ? -1 : 1;
      }
      return b.pop - a.pop;
    });
  }

  function syncSpotControls(view) {
    var counts = { all: view.places.length };
    view.places.forEach(function (p) { var k = kindBucket(p.kind); counts[k] = (counts[k] || 0) + 1; });
    if (spotFilter !== 'all' && !counts[spotFilter]) spotFilter = 'all';
    document.querySelectorAll('#spot-filter .seg__btn').forEach(function (b) {
      var f = b.dataset.filter, c = counts[f] || 0;
      b.textContent = b.dataset.label + ' ' + c;
      b.disabled = f !== 'all' && c === 0;
      b.setAttribute('aria-pressed', f === spotFilter ? 'true' : 'false');
    });
    document.querySelectorAll('#spot-sort .seg__btn').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.sort === spotSort ? 'true' : 'false');
    });
    document.getElementById('spot-controls').hidden = !view.places.length;
  }

  // 조건에 맞는 장소가 적을 때(지도 데이터 한계) 네이버/카카오에서 직접 찾을 수 있게 안내
  function appendPlaceHints(box, view, area) {
    (view.placesHints || []).forEach(function (h) {
      var d = el('div', 'places__hint');
      d.appendChild(document.createTextNode(h.count
        ? '‘' + h.label + '’ 조건에 맞는 장소를 ' + (view.placesSource === 'ai' ? '추천 목록' : '지도 데이터') + '에서 ' + h.count + '곳만 찾았어요. 더 찾아보기: '
        : '‘' + h.label + '’ 조건에 맞는 장소가 ' + (view.placesSource === 'ai' ? '추천 목록' : '지도 데이터') + '에 없어요. 직접 검색해 보세요: '));
      [['naver', '네이버지도'], ['kakao', '카카오맵']].forEach(function (pv) {
        var a = el('a', null, pv[1] + ' ‘' + h.search + '’');
        a.href = searchUrl(pv[0], area + ' ' + h.search);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        d.appendChild(a);
      });
      box.appendChild(d);
    });
  }

  function renderPlaces(view) {
    var best = view.recs[0];
    var area = stationShort(best.station);
    document.getElementById('places-station').textContent = area;
    var matchedN = view.places.filter(function (p) { return p.why && p.why.length; }).length;
    document.getElementById('places-count').textContent = view.places.length
      ? view.places.length + '곳' + ((view.placesProfile || matchedN) ? ' · 조건 일치 ' + matchedN : '') : '';
    var src = document.getElementById('places-source');
    var note = document.getElementById('places-note');
    var box = document.getElementById('places');
    box.textContent = '';
    syncSpotControls(view);

    if (view.placesSource === 'osm') {
      src.textContent = 'OpenStreetMap 데이터'; src.className = 'mode-badge mode-badge--live';
      note.textContent = '※ OpenStreetMap에 등록된 실제 장소예요. 리뷰 데이터가 없어 정보가 풍부한 순으로 인기를 추정하고, 영업시간·메뉴는 지도 링크에서 확인해 주세요. (Claude API 키를 넣으면 유명 스팟과 대표 메뉴·특징까지 추천해요)';
    } else if (view.placesSource === 'ai') {
      src.textContent = 'AI 추천'; src.className = 'mode-badge mode-badge--demo';
      note.textContent = '※ AI가 알고 있는 정보 기준이라 폐업·이전·변경이 있을 수 있어요. 인기순은 AI가 꼽은 유명도 순이고, 거리는 주소를 지도에서 찾아 계산해요. 방문 전 지도 링크로 꼭 확인해 주세요.';
    } else {
      src.textContent = ''; src.className = 'mode-badge';
      note.textContent = '';
    }

    if (view.placesLoading) {
      src.textContent = ''; src.className = 'mode-badge'; note.textContent = '';
      box.appendChild(el('div', 'places__empty', '⏳ 선택한 조건에 맞는 장소를 찾는 중이에요… (OpenStreetMap 데이터, 최대 15초)'));
      return;
    }

    if (!view.places.length) {
      box.appendChild(el('div', 'places__empty', view.placesError
        ? '주변 스팟 정보를 불러오지 못했어요. 위 카테고리 태그나 아래 링크로 지도에서 직접 찾아보세요.'
        : '이 지역에서 보여드릴 스팟 정보를 찾지 못했어요. 아래 카테고리 태그로 지도에서 직접 찾아보세요.'));
      appendPlaceHints(box, view, area);
      return;
    }

    var list = visibleSpots(view);
    if (!list.length) {
      box.appendChild(el('div', 'places__empty', '이 종류의 스팟은 없어요. 다른 필터를 선택해 보세요.'));
      return;
    }

    list.forEach(function (p, i) {
      var card = el('article', 'place');
      var top = el('div', 'place__top');
      top.appendChild(el('div', 'place__no', String(i + 1)));
      var head = el('div');
      head.appendChild(el('h4', 'place__name', p.name));
      head.appendChild(el('span', 'place__cat', (KIND_ICON[p.kind] || '📍') + ' ' + (p.category || p.kind)));
      top.appendChild(head);
      card.appendChild(top);

      if (p.why && p.why.length) { // 이 장소가 어떤 조건에 맞아서 올라왔는지 보여준다
        var why = el('div', 'place__why');
        p.why.slice(0, 4).forEach(function (w) { why.appendChild(el('span', null, '✓ ' + w)); });
        card.appendChild(why);
      }

      var dl = el('dl');
      dl.style.margin = '0'; dl.style.display = 'grid'; dl.style.gap = '6px';
      function row(k, v) {
        var r = el('div', 'place__row');
        r.appendChild(el('dt', null, k));
        r.appendChild(el('dd', null, v));
        dl.appendChild(r);
      }
      row('주소', p.address || '주소 정보 없음 — 지도에서 확인');
      if (p.dist != null) row('거리', fmtDist(p.dist) + ' · ' + area + ' 기준');
      else if (view.placeDistLoading) row('거리', '확인 중…');
      if (p.signature) row(p.kind === '식당' || p.kind === '카페' ? '대표메뉴' : '특징', p.signature);
      card.appendChild(dl);

      var links = el('div', 'place__links');
      var q = p.name + ' ' + area;
      var n = el('a', 'lnk--naver', '네이버지도'); n.href = searchUrl('naver', q);
      var k = el('a', 'lnk--kakao', '카카오맵'); k.href = searchUrl('kakao', q);
      [n, k].forEach(function (a) { a.target = '_blank'; a.rel = 'noopener noreferrer'; links.appendChild(a); });
      card.appendChild(links);
      box.appendChild(card);
    });
    appendPlaceHints(box, view, area);
  }

  document.getElementById('spot-controls').addEventListener('click', function (e) {
    var b = e.target.closest('.seg__btn');
    if (!b || b.disabled || !lastShare) return;
    if (b.dataset.sort) spotSort = b.dataset.sort;
    else if (b.dataset.filter) spotFilter = b.dataset.filter;
    else return;
    renderPlaces(lastShare.view);
  });

  // Claude가 준 스팟은 좌표가 없으므로 주소(없으면 이름)를 Nominatim으로 찾아 거리를 계산한다. 3km 밖 결과는 오매칭으로 보고 버린다
  function refinePlaceCoords(view) {
    var best = view.recs[0];
    if (!best.coord) return Promise.resolve();
    var area = stationShort(best.station);
    return view.places.reduce(function (chain, p) {
      return chain.then(function () {
        if (p.coord) return;
        var queries = [];
        if (p.address) queries.push(p.address);
        queries.push(area + ' ' + p.name);
        var i = 0;
        function next() {
          if (i >= queries.length) return null;
          return geocode(queries[i++], best.coord).then(function (g) {
            if (g && distKm(g, best.coord) <= 3) {
              p.coord = { lat: g.lat, lng: g.lng };
              p.dist = Math.round(distKm(g, best.coord) * 1000);
              return null;
            }
            return next();
          });
        }
        return Promise.resolve(next()).catch(function () { /* 거리 계산 실패 시 거리 없이 표시 */ });
      });
    }, Promise.resolve());
  }

  /* ───────────── 공유 (링크 / 카카오톡 텍스트) ───────────── */

  var lastShare = null; // { view, payload }

  function b64enc(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64dec(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function r4(n) { return Math.round(n * 10000) / 10000; }

  // 결과 스냅샷을 URL 해시에 담아, 링크를 열면 API 호출 없이 같은 결과가 복원되도록 함
  function snapshotOf(view, payload, slim) {
    var s = {
      v: 1,
      c: payload.conditions || '',
      b: payload.budgetPerPerson,
      o: view.origins.map(function (o) { return [o.name, o.place, o.coord ? r4(o.coord.lat) : null, o.coord ? r4(o.coord.lng) : null]; }),
      r: view.recs.map(function (r) {
        return [r.station, r.line, r.coord ? r4(r.coord.lat) : null, r.coord ? r4(r.coord.lng) : null, r.reason, r.travel.map(function (t) { return t.minutes; })];
      })
    };
    if (!slim) {
      s.br = view.briefing.map(function (b) { return [b.headline, b.keywords]; });
      s.ct = view.cats.map(function (c) { return [c.emoji, c.title, c.description, c.keywords]; });
      s.pl = view.places.slice().sort(function (a, b) { return b.pop - a.pop; }).slice(0, 6).map(function (p) {
        return [p.name, p.category, p.address, p.signature, p.kind, p.coord ? r4(p.coord.lat) : null, p.coord ? r4(p.coord.lng) : null, (p.why || []).slice(0, 4)];
      });
      s.ps = view.placesSource || '';
    }
    return s;
  }

  function buildShareLink(view, payload) {
    var base = location.href.split('#')[0];
    var link = base + '#r=' + b64enc(JSON.stringify(snapshotOf(view, payload, false)));
    if (link.length > 6000) link = base + '#r=' + b64enc(JSON.stringify(snapshotOf(view, payload, true)));
    return link;
  }

  var MEDALS = ['🥇', '🥈', '🥉'];

  function buildShareText(view, payload, link) {
    var lines = ['📍 모여라 AI · 약속 장소 추천', ''];
    view.recs.forEach(function (r, i) {
      lines.push(MEDALS[i] + ' ' + (i + 1) + '위 ' + r.station + ' (평균 ' + r.st.avg + '분 · 공평성 ' + r.st.fairness + '점)');
    });
    lines.push('', '⏱ 1위까지 이동시간');
    view.recs[0].travel.forEach(function (t) { lines.push('· ' + t.person + ' ' + t.from + ' → ' + t.minutes + '분'); });
    if (view.briefing.length) {
      lines.push('');
      view.briefing.forEach(function (b, i) { lines.push('💬 ' + BRIEF_META[i].label + ': ' + b.headline); });
    }
    if (view.places.length) {
      lines.push('', '📍 ' + stationShort(view.recs[0].station) + ' 주변 추천 스팟');
      view.places.slice().sort(function (a, b) { return b.pop - a.pop; }).slice(0, 5).forEach(function (p) {
        lines.push('· ' + (KIND_ICON[p.kind] || '📍') + ' ' + p.name + (p.category ? ' (' + p.category + ')' : ''));
      });
    }
    if (payload.conditions) lines.push('', '📝 조건: ' + payload.conditions);
    lines.push('', '🔗 ' + link);
    return lines.join('\n');
  }

  function renderShare(view, payload) {
    lastShare = { view: view, payload: payload };
    // 미리보기에서는 긴 링크를 줄여 보여주고, 실제 복사 텍스트에는 전체 링크가 들어감
    document.getElementById('share-preview').textContent = buildShareText(view, payload, '(결과 링크가 여기에 자동으로 들어가요)');
    setShareStatus('', false);
  }

  function setShareStatus(msg, isErr) {
    var s = document.getElementById('share-status');
    s.textContent = msg;
    s.className = 'share__status' + (isErr ? ' share__status--err' : '');
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function onShare(kind) {
    if (!lastShare) return;
    var link = buildShareLink(lastShare.view, lastShare.payload);
    var text = kind === 'link' ? link : buildShareText(lastShare.view, lastShare.payload, link);
    copyText(text).then(function () {
      setShareStatus(kind === 'link' ? '✓ 결과 링크를 복사했어요. 친구에게 붙여넣기 해 보세요!' : '✓ 카카오톡 공유 텍스트를 복사했어요. 채팅방에 붙여넣기 해 보세요!', false);
    }, function () {
      setShareStatus('복사에 실패했어요. 위 미리보기 텍스트를 직접 선택해 복사해 주세요.', true);
    });
  }

  document.getElementById('copy-link').addEventListener('click', function () { onShare('link'); });
  document.getElementById('copy-kakao').addEventListener('click', function () { onShare('kakao'); });

  function renderResult(view, source, payload) {
    var globalMax = 1;
    view.recs.forEach(function (r) { globalMax = Math.max(globalMax, r.st.max); });

    renderSummary(view);

    var top3 = document.getElementById('top3');
    top3.textContent = '';
    view.recs.forEach(function (r) { top3.appendChild(renderRec(r, globalMax)); });
    var legend = el('p', 'legend');
    top3.appendChild(legend);
    legend.style.gridColumn = '1 / -1';
    legend.appendChild(el('i'));
    legend.appendChild(document.createTextNode('주황색 막대 = 가장 오래 걸리는 사람 · 막대 길이는 3개 후보 전체에서 같은 기준(최장 ' + globalMax + '분)'));

    spotFilter = 'all'; spotSort = 'pop'; // 새 결과마다 필터·정렬 초기화
    renderPlaces(view);
    renderShare(view, payload);

    var best = view.recs[0].station;
    document.getElementById('cat-sub').textContent = '1위 ' + best + ' 주변에서 바로 검색해 볼 수 있어요.';
    var catBox = document.getElementById('categories');
    catBox.textContent = '';
    view.cats.forEach(function (c) {
      var box = el('div', 'cat');
      box.appendChild(el('div', 'cat__title', c.emoji + ' ' + c.title));
      box.appendChild(el('p', 'cat__desc', c.description));
      var tags = el('div', 'cat__tags');
      c.keywords.forEach(function (k) {
        var a = el('a', null, '#' + k);
        a.href = 'https://map.naver.com/p/search/' + encodeURIComponent(best + ' ' + k);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        tags.appendChild(a);
      });
      box.appendChild(tags);
      catBox.appendChild(box);
    });

    var src = document.getElementById('result-source');
    src.textContent = source === 'claude' ? 'Claude 분석' : source === 'shared' ? '공유된 결과' : '무료 로컬 분석';
    src.className = 'mode-badge ' + (source === 'claude' ? 'mode-badge--live' : source === 'shared' ? '' : 'mode-badge--demo');

    var notice = document.getElementById('result-notice');
    notice.textContent = view.notice;
    notice.hidden = !view.notice;

    result.hidden = false;
    syncEmpty();
    // 0폭 상태를 먼저 렌더(리플로우 강제)한 뒤 폭을 적용해야 transition 애니메이션이 재생됨
    void result.offsetWidth;
    result.querySelectorAll('.bar__fill').forEach(function (f) { f.style.width = f.dataset.w + '%'; });
    result.querySelectorAll('.cmp__fill').forEach(function (f) { f.style.width = f.dataset.w + '%'; });

    // 지도는 결과 영역이 보인 뒤에 그려야 크기가 올바르게 계산됨. 지도 오류가 결과 표시를 막지 않도록 격리
    try { renderMap(view); } catch (err) {
      var fb = document.getElementById('map-fallback');
      fb.textContent = '지도를 표시하는 중 문제가 생겼어요: ' + err.message;
      fb.hidden = false;
    }
    // display:none → 표시 전환 직후/레이아웃 안정화 후 두 번 크기를 다시 잡는다
    refreshMapSize();
    setTimeout(refreshMapSize, 200);
    // 모바일은 지도가 결과 위에 붙어 있으므로 맨 위로, 데스크톱은 왼쪽 패널만 맨 위로
    if (window.matchMedia('(max-width: 1023px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
    else paneLeft.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ───────────── 탭 (1. 약속 설정 / 2. AI 결과 분석) ───────────── */

  // 로딩도 결과도 없을 때만 '아직 결과 없음' 안내를 보여준다
  function syncEmpty() { resultEmpty.hidden = !loading.hidden || !result.hidden; }

  function showTab(name, noScroll) {
    var isResult = name === 'result';
    document.body.dataset.tab = name; // 모바일에서 지도 패널은 결과 탭에서만 보인다 (CSS)
    tabSetup.setAttribute('aria-selected', isResult ? 'false' : 'true');
    tabResult.setAttribute('aria-selected', isResult ? 'true' : 'false');
    tabSetup.tabIndex = isResult ? -1 : 0;
    tabResult.tabIndex = isResult ? 0 : -1;
    panelSetup.hidden = isResult;
    panelResult.hidden = !isResult;
    var p = isResult ? panelResult : panelSetup;
    p.classList.remove('panel--enter');
    void p.offsetWidth; // 애니메이션 재시작
    p.classList.add('panel--enter');
    syncEmpty();
    // 숨겨져 있던 탭의 지도는 크기가 0으로 계산돼 있으므로 다시 보일 때 크기를 갱신
    if (isResult) { refreshMapSize(); setTimeout(refreshMapSize, 200); }
    if (!noScroll) {
      window.scrollTo({ top: 0, behavior: 'smooth' });          // 모바일: 페이지 스크롤
      paneLeft.scrollTo({ top: 0, behavior: 'smooth' });        // 데스크톱: 왼쪽 패널 스크롤
    }
  }

  /* ───────────── 로딩 애니메이션 ───────────── */

  var stepTimer = null;
  function startLoading() {
    var steps = document.querySelectorAll('#loading-steps li');
    var i = 0;
    function paint() {
      steps.forEach(function (li, idx) {
        li.classList.toggle('is-done', idx < i);
        li.classList.toggle('is-active', idx === i);
      });
    }
    paint();
    clearInterval(stepTimer);
    stepTimer = setInterval(function () { if (i < steps.length - 1) { i++; paint(); } }, 1600);
    result.hidden = true;
    loading.hidden = false;
    syncEmpty();
  }
  function stopLoading() {
    clearInterval(stepTimer);
    loading.hidden = true;
  }

  /* ───────────── 제출 처리 ───────────── */

  function minDelay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 출발지 텍스트 → 좌표. 내장 역 표(오프라인·즉시) → Nominatim(전국) 순. "홍대 9번출구" 같은 입력은 변형해서 재시도 */
  function placeVariants(text) {
    var t = text.trim(), v = [t];
    var noExit = t.replace(/\s*\d*\s*번?\s*출구\s*$/, '').trim();
    if (noExit && noExit !== t) v.push(noExit);
    var base = noExit || t;
    if (!/(역|동|구|시|군|읍|면|리|로|길|대학교|공원|터미널)$/.test(base)) v.push(base + '역');
    return v.filter(function (x, i) { return x && v.indexOf(x) === i; });
  }

  function geocodePlace(text) {
    var variants = placeVariants(text), lastErr = null, i = 0;
    function next() {
      if (i >= variants.length) {
        var loose = findStation(text, false);
        if (loose) return Promise.resolve({ lat: loose.lat, lng: loose.lng, name: loose.label });
        if (lastErr) { var e = new Error('network'); e.network = true; throw e; }
        return null;
      }
      var v = variants[i++];
      var hit = findStation(v, true);
      if (hit) return Promise.resolve({ lat: hit.lat, lng: hit.lng, name: hit.label });
      return geocode(v, null).then(function (r) { return r || next(); }, function (err) { lastErr = err; return next(); });
    }
    return Promise.resolve(next());
  }

  function geocodeOrigins(origins) {
    var failed = [], netFail = false;
    return origins.reduce(function (chain, o) {
      return chain.then(function () {
        if (o.coord) return; // GPS 출발지는 이미 좌표가 있음
        return geocodePlace(o.place).then(function (r) {
          if (!r) { failed.push(o.place); return; }
          o.lat = r4(r.lat); o.lng = r4(r.lng); o.coord = { lat: o.lat, lng: o.lng }; o.resolved = r.name;
        }, function (err) { if (err && err.network) netFail = true; failed.push(o.place); });
      });
    }, Promise.resolve()).then(function () {
      if (netFail) throw new Error('위치 검색 서비스(OpenStreetMap Nominatim)에 연결하지 못했어요. 인터넷 연결을 확인하거나, 주요 역 이름(예: 강남역)으로 입력해 보세요.');
      if (failed.length) throw new Error('장소를 찾지 못했어요: ' + failed.join(', ') + ' — 시·구·동을 포함해 더 구체적으로 입력해 주세요 (예: 대전 유성구 봉명동).');
    });
  }

  /* Claude가 준 추천 장소 좌표 보정: 내장 표에 없는 장소는 Nominatim으로 확인하고, 모델 좌표와 크게 다르면 출발지에 더 가까운 쪽 선택 */
  function refineCoords(view) {
    var pts = view.origins.filter(function (o) { return o.coord; }).map(function (o) { return o.coord; });
    if (!pts.length) return Promise.resolve(view);
    var centroid = {
      lat: pts.reduce(function (a, c) { return a + c.lat; }, 0) / pts.length,
      lng: pts.reduce(function (a, c) { return a + c.lng; }, 0) / pts.length
    };
    return view.recs.reduce(function (chain, r) {
      return chain.then(function () {
        if (findStation(r.station, true)) return;
        return geocode(stationShort(r.station), centroid).then(function (g) {
          if (!g) return;
          if (!r.coord) { r.coord = { lat: g.lat, lng: g.lng }; return; }
          if (distKm(r.coord, g) > 30 && distKm(centroid, g) < distKm(centroid, r.coord)) r.coord = { lat: g.lat, lng: g.lng };
        }).catch(function () { /* 보정 실패 시 모델 좌표 유지 */ });
      });
    }, Promise.resolve()).then(function () { return view; });
  }

  function ensurePlaces(view, payload) {
    if (view.places.length) return Promise.resolve(view);
    var best = view.recs[0];
    if (!best.coord) { view.placesError = true; return Promise.resolve(view); }
    return nominatimPlaces(best.coord, payload.conditions).then(function (res) {
      view.places = res.list;
      view.placesHints = res.hints;
      view.placesProfile = res.profileActive;
      view.placesSource = res.list.length ? 'osm' : '';
      return view;
    }, function () { view.placesError = true; return view; });
  }

  function claudePayload(payload) {
    return {
      origins: payload.origins.map(function (o) { return { name: o.name, place: o.place, lat: o.lat, lng: o.lng }; }),
      conditions: payload.conditions,
      budgetPerPerson: payload.budgetPerPerson
    };
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var origins = Array.prototype.map.call(originList.querySelectorAll('input'), function (i, idx) {
      var o = { name: LABELS[idx], place: i.value.trim() };
      var c = i.dataset.lat ? validCoord(i.dataset.lat, i.dataset.lng) : null; // GPS로 입력한 출발지는 좌표를 그대로 사용
      if (c) { o.lat = r4(c.lat); o.lng = r4(c.lng); o.coord = { lat: o.lat, lng: o.lng }; }
      return o;
    }).filter(function (o) { return o.place; });

    if (origins.length < 2) {
      showError('출발지를 최소 2곳 이상 입력해 주세요.');
      return;
    }
    showError('');
    showTab('result'); // 분석 시작과 동시에 결과 탭으로 부드럽게 이동 (로딩 표시)

    var payload = {
      origins: origins,
      conditions: conditions.value.trim(),
      budgetPerPerson: Number(budget.value) >= 100000 ? null : Number(budget.value)
    };

    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '분석 중…';
    startLoading();

    var key = getKey();
    var apiNote = '';
    var minWait = minDelay(1500); // 캐시 적중 등으로 너무 빨라도 로딩 상태가 보이도록

    var run = geocodeOrigins(origins).then(function () {
      if (!key) {
        return localAnalyze(payload).then(function (raw) { return { view: normalize(raw, origins), source: 'local' }; });
      }
      return callClaude(claudePayload(payload), key).then(function (raw) {
        return refineCoords(normalize(raw, origins)).then(function (view) { applyConditionMatch(view, payload.conditions); return { view: view, source: 'claude' }; });
      }).catch(function (err) {
        // API 실패 시 무료 로컬 엔진으로 대체하되 이유를 사용자에게 알림
        apiNote = 'Claude 호출에 실패해 무료 로컬 분석 결과로 대신 보여드려요 (' + err.message + ')';
        return localAnalyze(payload).then(function (raw) { return { view: normalize(raw, origins), source: 'local' }; });
      });
    }).then(function (out) {
      return minWait.then(function () { return out; });
    });

    run.then(function (out) {
      if (apiNote) out.view.notice = apiNote + (out.view.notice ? ' · ' + out.view.notice : '');
      var view = out.view;
      // 주변 가게 조회는 몇 초 걸릴 수 있어 결과를 먼저 보여주고 뒤에서 채운다
      view.placesLoading = !view.places.length && !!view.recs[0].coord;
      view.placeDistLoading = view.placesSource === 'ai' && view.places.some(function (p) { return !p.coord; });
      stopLoading();
      renderResult(view, out.source, payload);
      if (view.placesLoading || view.placeDistLoading) {
        (view.placesLoading ? ensurePlaces(view, payload) : refinePlaceCoords(view)).then(function () {
          view.placesLoading = false;
          view.placeDistLoading = false;
          if (lastShare && lastShare.view === view) { renderPlaces(view); renderShare(view, payload); }
        });
      }
    }).catch(function (err) {
      stopLoading();
      showTab('setup'); // 오류는 설정 탭에서 보여주고 바로 수정할 수 있게 되돌린다
      showError(apiNote ? apiNote + ' / ' + err.message : err.message);
    }).then(function () {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = IDLE_LABEL;
    });
  });

  /* ───────────── 공유 링크 복원 (#r=...) ───────────── */

  function setOriginInputs(places) {
    var rows = originList.querySelectorAll('.origin-row');
    var need = Math.max(MIN_ORIGINS, Math.min(MAX_ORIGINS, places.length));
    for (var i = rows.length; i < need; i++) addOrigin(true);
    rows = originList.querySelectorAll('.origin-row');
    for (var j = rows.length - 1; j >= need; j--) rows[j].remove();
    originList.querySelectorAll('input').forEach(function (inp, k) { inp.value = places[k] || ''; delete inp.dataset.lat; delete inp.dataset.lng; });
    relabelOrigins();
  }

  function restoreFromHash() {
    var m = /^#r=([\w-]+)$/.exec(location.hash);
    if (!m) return;
    try {
      var s = JSON.parse(b64dec(m[1]));
      if (!s || s.v !== 1 || !Array.isArray(s.o) || !Array.isArray(s.r) || !s.r.length) throw new Error('형식 오류');
      var origins = s.o.slice(0, MAX_ORIGINS).map(function (a, i) {
        return { name: LABELS.indexOf(a[0]) !== -1 && a[0].length === 1 ? a[0] : LABELS[i], place: String(a[1] || '').slice(0, 80), coord: validCoord(a[2], a[3]) };
      });
      var raw = {
        recommendations: s.r.slice(0, 3).map(function (r) {
          return {
            station: String(r[0]), line: String(r[1] || ''), lat: r[2], lng: r[3], reason: String(r[4] || ''),
            travel: origins.map(function (o, k) { return { person: o.name, minutes: Array.isArray(r[5]) ? r[5][k] : NaN }; })
          };
        }),
        briefing: (Array.isArray(s.br) ? s.br : []).map(function (a) { return Array.isArray(a) ? { headline: a[0], keywords: a[1] } : a; }),
        categories: (Array.isArray(s.ct) ? s.ct : []).map(function (c) { return { emoji: c[0], title: c[1], description: c[2], keywords: c[3] }; }),
        places: (Array.isArray(s.pl) ? s.pl : []).map(function (p) { return { name: p[0], category: p[1], address: p[2], signature: p[3], kind: p[4], lat: p[5], lng: p[6], why: p[7] }; }),
        placesSource: s.ps === 'osm' ? 'osm' : 'ai'
      };
      var view = normalize(raw, origins);
      var cond = String(s.c || '').slice(0, 500);
      var bud = s.b == null ? null : Number(s.b);

      setOriginInputs(origins.map(function (o) { return o.place; }));
      conditions.value = cond;
      conditions.dispatchEvent(new Event('input'));
      budget.value = bud == null || !isFinite(bud) ? 100000 : clamp(bud, 10000, 100000);
      updateBudget();

      showTab('result', true);
      renderResult(view, 'shared', { origins: origins, conditions: cond, budgetPerPerson: bud });
    } catch (err) {
      showError('공유 링크의 결과를 불러오지 못했어요. 링크가 잘렸거나 올바르지 않아요.');
    }
  }

  tabSetup.addEventListener('click', function () { showTab('setup'); });
  tabResult.addEventListener('click', function () { showTab('result'); });
  document.getElementById('back-to-setup').addEventListener('click', function () { showTab('setup'); });
  document.getElementById('go-setup').addEventListener('click', function () { showTab('setup'); });
  document.querySelector('.tabs').addEventListener('keydown', function (e) {
    var to = { ArrowRight: 'result', ArrowLeft: 'setup', Home: 'setup', End: 'result' }[e.key];
    if (!to) return;
    e.preventDefault();
    showTab(to, true);
    (to === 'result' ? tabResult : tabSetup).focus();
  });

  ensureMap();
  renderTemplates();
  updateBudget();
  refreshMode();
  relabelOrigins();
  syncChips();
  restoreFromHash();
})();
