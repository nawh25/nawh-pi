# nawh-subagents

pi-coding-agent 확장으로, 다중 전문 서브에이전트를 실행·관리·라우팅합니다.

- **7개 기본 에이전트**: explorer, oracle, librarian, fixer, designer, council, observer
- **3가지 실행 모드**: Single, Parallel, Chain
- **프리셋 시스템**: JSON 설정 파일로 에이전트별 모델·도구·thinking 예산 오버라이드
- **다중 LLM 합의 (Council)**: 여러 모델의 답변을 수집·종합

---

## 목차

1. [서브에이전트 정의 (`.md` 파일)](#1-서브에이전트-정의-md-파일)
2. [에이전트 등록 위치 & 우선순위](#2-에이전트-등록-위치--우선순위)
3. [JSON 설정 파일 (`~/.pi/agent/nawh-subagents.json`)](#3-json-설정-파일-piagentnawh-subagentsjson)
4. [프리셋으로 에이전트 오버라이드하기](#4-프리셋으로-에이전트-오버라이드하기)
5. [Council (다중 LLM 합의) 설정](#5-council-다중-llm-합의-설정)
6. [에이전트 비활성화 / 활성화](#6-에이전트-비활성화--활성화)
7. [실행 제한 설정](#7-실행-제한-설정)
8. [전체 설정 예시](#8-전체-설정-예시)
9. [`/subagents` 명령어](#9-subagents-명령어)

---

## 1. 서브에이전트 정의 (`.md` 파일)

각 에이전트는 YAML 프론트매터와 Markdown 본문(시스템 프롬프트)으로 구성된 `.md` 파일로 정의합니다.

### 1.1 프론트매터 필드

| 필드           | 타입                | 필수 | 설명                                                                  |
| -------------- | ------------------- | ---- | --------------------------------------------------------------------- |
| `name`         | string              | ✅   | 에이전트 이름 (예: `explorer`, `oracle`). 다른 에이전트와 중복 불가.  |
| `description`  | string              |      | 에이전트 설명. 라우팅 프롬프트와 에이전트 목록에 표시됨.               |
| `tools`        | string[]            |      | 에이전트가 사용할 수 있는 도구 목록.                                   |
| `model`        | string              |      | 모델 식별자 (예: `anthropic/claude-haiku-4-5`).                       |
| `thinking`     | `"low"` / `"medium"` / `"high"` |      | thinking(사고) 예산 레벨.                                              |
| `is_council`   | boolean             |      | `true`이면 Council(다중 LLM 합의) 에이전트로 동작.                     |
| `locked`       | boolean             |      | `true`이면 프리셋이 model/thinking/tools를 오버라이드할 수 없음.       |

### 1.2 `tools` 값

도구는 pi-coding-agent가 제공하는 빌트인 도구 이름을 사용합니다.

```
read, write, edit, grep, find, ls, bash
```

> 읽기 전용 에이전트는 `read, grep, find, ls, bash`만 부여하고,
> 구현 에이전트는 `write`, `edit`까지 부여합니다.

### 1.3 `model` 값

`<provider>/<model-name>` 형식을 사용합니다.

| 에이전트    | 기본 model                        | 비고                      |
| ----------- | --------------------------------- | ------------------------- |
| explorer    | `anthropic/claude-haiku-4-5`      | 빠르고 저렴                |
| fixer       | `anthropic/claude-haiku-4-5`      | 빠른 구현                 |
| librarian   | `anthropic/claude-haiku-4-5`      | 빠른 문서 검색             |
| observer    | `google/gemini-2.5-flash`         | 비전(Vision) 지원          |
| designer    | `anthropic/claude-haiku-4-5`     | UI/UX                     |
| oracle      | `anthropic/claude-opus-4-1`       | 고성능 전략 분석           |
| council     | (시스템 프롬프트용)               | councillors는 별도 설정    |

### 1.4 `.md` 파일 예시

```markdown
---
name: my-explorer
description: 내 커스텀 코드 탐색 에이전트
tools:
  - read
  - grep
  - find
  - ls
model: anthropic/claude-haiku-4-5
thinking: low
---

You are the **My Explorer**, a fast read-only codebase reconnaissance specialist.
...
```

### 1.5 `locked: true` (프리셋 오버라이드 방지)

```markdown
---
name: secure-reviewer
description: 보안 전용 리뷰어 (설정 변경 불가)
tools:
  - read
  - grep
model: anthropic/claude-opus-4-1
thinking: high
locked: true
---
```

`locked: true`이면 JSON 프리셋에서 model·thinking·tools를 설정해도 **무시되고 프론트매터 값이 우선**합니다.

### 1.6 Council 에이전트 예시

```markdown
---
name: council
description: Multi-LLM consensus agent
tools:
  - read
  - grep
  - find
  - ls
is_council: true
locked: true
---

You are the **Council Synthesizer**...
```

`is_council: true`이면 실제 councillor(평의원) 모델들은
JSON 설정 파일의 `presets`에 있는 `councillors` 배열로 정의합니다.
[§5 Council 설정](#5-council-다중-llm-합의-설정) 참조.

---

## 2. 에이전트 등록 위치 & 우선순위

에이전트는 3계층으로 발견(discovery)되며, **뒤쪽 계층이 앞쪽 계층을 덮어씁니다**.

| 우선순위 | 위치                                  | 설명                            |
| -------- | ------------------------------------- | ------------------------------- |
| 1 (base) | 확장 번들 `agents/*.md`               | 7개 기본 에이전트 (항상 로드됨)  |
| 2        | `~/.pi/agent/agents/*.md`             | 사용자 수준 에이전트            |
| 3 (최고) | `.pi/agents/*.md` (프로젝트 루트부터) | 프로젝트 수준 에이전트          |

> 같은 `name`의 에이전트가 여러 계층에 있으면
> project → user → extension 순으로 덮어씁니다.

### agentScope 옵션

`subagent` 툴 호출 시 `agentScope`로 어디까지 로드할지 제어합니다.

| 값        | 로드되는 에이전트                              |
| --------- | ----------------------------------------------- |
| `user`    | extension + user                                |
| `project` | extension + project                             |
| `both`    | extension + user + project (기본값)             |

---

## 3. JSON 설정 파일 (`~/.pi/agent/nawh-subagents.json`)

사용자 수준 설정 파일입니다. (프로젝트 수준 JSON 설정은 지원하지 않습니다.)

### 3.1 전체 스키마

```jsonc
{
  // 활성 프리셋 이름 (아래 presets 키 중 하나)
  "preset": "default",

  // 프리셋 정의: 이름 → { 에이전트명: 오버라이드 }
  "presets": {
    "default": {},
    "anthropic": { "explorer": { "model": "anthropic/claude-haiku-4-5" } },
    "cheap":    { "oracle":   { "model": "openai/gpt-4o-mini", "thinking": "low" } }
  },

  // 비활성화할 에이전트 이름 목록
  "disabledAgents": ["council"],

  // 최대 병렬 작업 수 (기본 8, 범위 1~20)
  "maxParallel": 8,

  // 최대 동시 서브프로세스 수 (기본 4, 범위 1~20)
  "maxConcurrency": 4,

  // 프로젝트 에이전트 실행 전 사용자 확인 여부 (기본 true)
  "confirmProjectAgents": true
}
```

### 3.2 필드별 상세

| 필드                    | 타입       | 기본값        | 설명                                                                              |
| ----------------------- | ---------- | ------------- | --------------------------------------------------------------------------------- |
| `preset`                | string     | `"default"`   | `presets`에서 적용할 프리셋 이름. 존재하지 않으면 경고 후 프론트매터 기본값 사용.   |
| `presets`               | object     | `{}`          | `{ 프리셋명: { 에이전트명: AgentOverride } }` 구조.                                |
| `disabledAgents`        | string[]   | `[]`          | 비활성화할 에이전트 이름 배열. 라우팅 프롬프트에서도 제외됨.                       |
| `maxParallel`           | integer    | `8`           | 오케스트레이터가 동시에 띄울 수 있는 최대 작업 수 (1~20).                           |
| `maxConcurrency`        | integer    | `4`           | 동시에 실행되는 서브에이전트 서브프로세스 수 상한 (1~20).                           |
| `confirmProjectAgents`  | boolean    | `true`        | project/both 스코프에서 프로젝트 에이전트 실행 전 사용자 확인 다이얼로그 표시 여부.|

### 3.3 유효성 검사 규칙

- 파일이 없거나 JSON 파싱 실패 → 기본값 사용 + stderr 경고
- 개별 필드가 범위/타입에 맞지 않으면 → 해당 필드만 기본값으로 대체 + stderr 경고
- `preset`이 `presets`에 없으면 → 경고 후 프론트매터 기본값 사용

---

## 4. 프리셋으로 에이전트 오버라이드하기

프리셋의 `AgentOverride`로 에이전트의 model·thinking·tools를 덮어쓸 수 있습니다.
(`locked: true` 에이전트는 제외)

### 4.1 AgentOverride 필드

| 필드      | 타입               | 설명                                          |
| --------- | ------------------ | --------------------------------------------- |
| `model`   | string             | 에이전트가 사용할 모델로 덮어쓰기             |
| `thinking`| string             | `"low"` / `"medium"` / `"high"`               |
| `tools`   | string[]           | 도구 목록 전체 교체                           |
| `councillors` | CouncillorConfig[] | council 에이전트 전용. [§5](#5-council-다중-llm-합의-설정) 참조 |

### 4.2 오버라이드 예시

```jsonc
{
  "preset": "economy",
  "presets": {
    "economy": {
      "explorer": {
        "model": "openai/gpt-4o-mini",
        "thinking": "low"
      },
      "oracle": {
        "model": "anthropic/claude-sonnet-4-20250514",
        "thinking": "medium"
      },
      "fixer": {
        "model": "openai/gpt-4o-mini",
        "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"]
      }
    }
  }
}
```

### 4.3 병합 우선순위

```
프론트매터 기본값
  ↓ preset에 값이 있고 locked가 아니면 덮어쓰기
최종 설정
```

- `locked: true` → 프론트매터 값이 항상 최종
- `locked: false`(기본) → preset 값이 있으면 preset, 없으면 프론트매터

---

## 5. Council (다중 LLM 합의) 설정

`council` 에이전트는 여러 모델(councillor, 평의원)을 병렬로 실행한 뒤,
그 결과를 종합(synthesis)하는 특수 에이전트입니다.

### 5.1 CouncillorConfig 필드

| 필드      | 타입   | 필수 | 설명                                                          |
| --------- | ------ | ---- | ------------------------------------------------------------- |
| `name`    | string | ✅   | 평의원 표시 이름 (종합 결과에서 인용됨)                        |
| `model`   | string | ✅   | 평의원이 사용할 모델 식별자                                    |
| `variant` | string |      | thinking variant: `"low"` / `"medium"` / `"high"`            |
| `prompt`  | string |      | 평의원에게 전달할 역할/지시문 (사용자 질문 앞에 붙음)          |

### 5.2 councillors 설정 예시

```jsonc
{
  "preset": "default",
  "presets": {
    "default": {
      "council": {
        "councillors": [
          {
            "name": "strategist",
            "model": "anthropic/claude-sonnet-4-20250514",
            "prompt": "Focus on long-term architecture and strategy"
          },
          {
            "name": "skeptic",
            "model": "openai/gpt-4o",
            "prompt": "Challenge assumptions and find edge cases"
          },
          {
            "name": "pragmatist",
            "model": "anthropic/claude-haiku-4-5",
            "prompt": "Focus on practical implementation concerns",
            "variant": "low"
          }
        ]
      }
    }
  }
}
```

### 5.3 councillor 동작

1. 각 councillor이 병렬로 실행되어 사용자 질문에 답변
2. `prompt`가 있으면 `"역할 지시문\n\n사용자 질문"` 형태로 전달
3. `variant`로 thinking 예산 제어 가능
4. council 에이전트의 시스템 프롬프트가 종합(synthesis) 단계에서 사용됨

### 5.4 유효성 검사

- `name` 또는 `model`이 없으면 → 해당 councillor은 경고와 함께 스킵
- 유효한 councillor이 하나도 없으면 → 기본 councillor 세트 사용

---

## 6. 에이전트 비활성화 / 활성화

### 6.1 config에서 비활성화

```jsonc
{
  "disabledAgents": ["council", "observer"]
}
```

비활성화된 에이전트:

- 라우팅 프롬프트(orchestrator prompt)에서 제외
- `subagent` 툴의 사용 가능 에이전트 목록에서 제외

### 6.2 `/subagents` 명령어로 토글

`/subagents` → "Toggle agent enable/disable" 메뉴에서 on/off 전환.
세션 종료 시 메모리 상태는 사라지고, 영구 적용은 config 파일을 수정하세요.

---

## 7. 실행 제한 설정

```jsonc
{
  "maxParallel": 8,
  "maxConcurrency": 4
}
```

| 설정              | 의미                                                  | 기본값 | 범위  |
| ----------------- | ----------------------------------------------------- | ------ | ----- |
| `maxParallel`     | 오케스트레이터가 동시에 띄울 수 있는 최대 작업 수     | 8      | 1~20  |
| `maxConcurrency`  | 실제로 동시에 실행되는 서브프로세스 수 상한          | 4      | 1~20  |

> 병렬 작업이 많을수록 속도는 빨라지지만, 비용과 API rate-limit에 주의하세요.

---

## 8. 전체 설정 예시

```jsonc
{
  "preset": "balanced",
  "presets": {
    "default": {
      "council": {
        "councillors": [
          {
            "name": "strategist",
            "model": "anthropic/claude-sonnet-4-20250514",
            "prompt": "Focus on long-term architecture and strategy"
          },
          {
            "name": "skeptic",
            "model": "openai/gpt-4o",
            "prompt": "Challenge assumptions and find edge cases"
          },
          {
            "name": "pragmatist",
            "model": "anthropic/claude-haiku-4-5",
            "prompt": "Focus on practical implementation concerns"
          }
        ]
      }
    },
    "balanced": {
      "explorer": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" },
      "oracle":   { "model": "anthropic/claude-sonnet-4-20250514", "thinking": "high" },
      "fixer":    { "model": "anthropic/claude-haiku-4-5", "thinking": "low" },
      "designer": { "model": "anthropic/claude-haiku-4-5", "thinking": "medium" },
      "librarian":{ "model": "anthropic/claude-haiku-4-5", "thinking": "low" },
      "observer": { "model": "google/gemini-2.5-flash", "thinking": "low" },
      "council": {
        "councillors": [
          { "name": "arch",      "model": "anthropic/claude-opus-4-1",          "prompt": "Architecture focus" },
          { "name": "risk",      "model": "anthropic/claude-sonnet-4-20250514","prompt": "Risk and security focus" },
          { "name": "implement", "model": "anthropic/claude-haiku-4-5",        "prompt": "Implementation focus" }
        ]
      }
    },
    "economy": {
      "explorer": { "model": "openai/gpt-4o-mini", "thinking": "low" },
      "oracle":   { "model": "openai/gpt-4o-mini", "thinking": "medium" },
      "fixer":    { "model": "openai/gpt-4o-mini", "thinking": "low" },
      "designer": { "model": "openai/gpt-4o-mini", "thinking": "low" },
      "librarian":{ "model": "openai/gpt-4o-mini", "thinking": "low" },
      "observer": { "model": "google/gemini-2.5-flash", "thinking": "low" },
      "council": {
        "councillors": [
          { "name": "a", "model": "openai/gpt-4o-mini", "prompt": "Be concise" },
          { "name": "b", "model": "anthropic/claude-haiku-4-5", "prompt": "Be concise" }
        ]
      }
    }
  },
  "disabledAgents": [],
  "maxParallel": 8,
  "maxConcurrency": 4,
  "confirmProjectAgents": true
}
```

---

## 9. `/subagents` 명령어

pi 내에서 `/subagents` 명령어로 현재 설정과 에이전트 상태를 확인할 수 있습니다.

### 표시 항목

```
╭─ Settings ─────────────────────────╮
│ Preset:           balanced
│ Max concurrency:  4
│ Max parallel:     8
│ Confirm project:  true
╰────────────────────────────────────╯

╭─ Agents ───────────────────────────╮
│ ✓ explorer [builtin]
│   Fast read-only codebase reconnaissance specialist
│ ✓ oracle [builtin]
│   Strategic technical advisor and code reviewer
│ ✓ council (council) 🔒 [builtin]
│   Multi-LLM consensus agent
│ ...
╰────────────────────────────────────╯
```

- `✓` 활성 / `✗` 비활성 (disabledAgents)
- `[builtin]` / `[user]` / `[project]` — 발견 출처
- `(council)` — is_council 에이전트
- `🔒` — locked (프리셋 오버라이드 불가)

### 인터랙티브 메뉴 (UI 사용 가능 시)

1. **View agent details** — 전체 에이전트 정보 표시
2. **Toggle agent enable/disable** — 에이전트 활성/비활성 전환
3. **Change preset** — 활성 프리셋 변경
4. **Change max concurrency** — 동시 실행 수 변경
5. **Exit**

> 인터랙티브 메뉴에서 변경한 값은 세션 내에서만 유효합니다.
> 영구 적용은 `~/.pi/agent/nawh-subagents.json`을 수정하세요.

---

## 요약: 설정 흐름도

```
~/.pi/agent/nawh-subagents.json  (JSON: preset, presets, disabledAgents, limits)
        │
        ▼
  loadConfig()  ──→  PantheonConfig
        │
        │  +  에이전트 .md (frontmatter + system prompt)
        ▼
  resolveAgentConfig()  ──→  최종 AgentConfig
        │
        │  locked: true 이면 프론트매터 우선
        │  locked: false 이면 preset 오버라이드 적용
        ▼
  runner.ts / council.ts  ──→  서브에이전트 실행
```
