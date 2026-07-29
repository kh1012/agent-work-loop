#!/usr/bin/env node
import { recordAutoFeedback } from './core/auto-feedback.js';
import { buildProgram } from './program.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // 이미 process.exit(1)로 처리된 알려진 에러는 여기 안 온다(즉시 종료라 이 catch를
  // 안 탄다) — 여기 오는 건 진짜 미처리 예외뿐이다(ADK stage 6, 도구 피드백 자동수집).
  await recordAutoFeedback(err, process.argv);
  throw err; // 기존처럼 스택트레이스를 보여주고 비정상 종료 코드로 끝난다 — 가리지 않는다.
}
