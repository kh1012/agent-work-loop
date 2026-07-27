import { describe, expect, it } from 'vitest';
import {
  type FrontmatterData,
  parseFrontmatter,
  serializeFrontmatter,
} from '../../src/core/doc-frontmatter.js';

describe('parseFrontmatter', () => {
  it('구분자가 없으면 null을 돌려준다', () => {
    expect(parseFrontmatter('그냥 본문입니다')).toBeNull();
  });

  it('닫는 구분자를 못 찾으면 null을 돌려준다', () => {
    expect(parseFrontmatter('---\nid: abc\n본문')).toBeNull();
  });

  it('문자열/배열/빈배열/빈문자열 필드를 파싱한다', () => {
    const content = [
      '---',
      'id: abc-123',
      'status: draft',
      'terms: [레이어, 티켓]',
      'tickets: []',
      'domain:',
      '---',
      '## Request',
      '',
    ].join('\n');
    const parsed = parseFrontmatter(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toEqual({
      id: 'abc-123',
      status: 'draft',
      terms: ['레이어', '티켓'],
      tickets: [],
      domain: '',
    });
    expect(parsed?.body).toBe('## Request\n');
  });

  it('알 수 없는 형식의 줄은 무시한다(관용적으로 읽는다)', () => {
    const content = '---\nid: abc\n이건 콜론이 없는 줄\nstatus: draft\n---\n본문';
    const parsed = parseFrontmatter(content);
    expect(parsed?.data).toEqual({ id: 'abc', status: 'draft' });
  });
});

describe('serializeFrontmatter', () => {
  it('write -> read 왕복이 동등하다', () => {
    const data: FrontmatterData = {
      id: '0192f8a1-7c3d-7e4a-b2f1-9d8e6c4a1b03',
      status: 'draft',
      terms: [],
      tickets: ['ticket-1', 'ticket-2'],
      domain: '',
    };
    const serialized = serializeFrontmatter(data);
    const parsed = parseFrontmatter(`${serialized}본문 내용`);
    expect(parsed?.data).toEqual(data);
    expect(parsed?.body).toBe('본문 내용');
  });
});
