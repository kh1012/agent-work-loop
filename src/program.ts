import { Command } from 'commander';
import { version } from '../package.json';

export const BANNER = `Agent Work Loop

같은 실패를 두 번 하지 않게 만드는 도구입니다.
awl 자체는 판단하지 않습니다. 파일과 상태만 관리합니다.
판단은 Claude Code 나 Codex 가 합니다.`;

/**
 * awl 명령어 트리를 만든다.
 *
 * `--help`에는 사람이 치는 명령만 보인다. 스킬 전용 명령(verify, record,
 * state, evolve)은 나중에 `{ hidden: true }`로 추가해 help에서 숨긴다.
 * 지금은 사람용 명령이 아직 없으므로 배너와 기본 옵션만 노출한다.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('awl')
    .version(version, '-v, --version', '버전을 출력합니다')
    .helpOption('-h, --help', '도움말을 출력합니다')
    .addHelpText('beforeAll', `${BANNER}\n`)
    .showHelpAfterError();

  // 인자 없이 `awl`만 실행하면 도움말을 보여준다.
  program.action(() => {
    program.help();
  });

  return program;
}
