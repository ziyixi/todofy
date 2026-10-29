import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORITY } from './Backup.tsx';
import { fixture, serve, show, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('备份', () => {
  it('states first that the SQLite record is authoritative and Notion an asynchronous copy', async () => {
    serve(world());
    show('#/backup');
    expect(await screen.findByRole('note')).toHaveTextContent(AUTHORITY);
    expect(AUTHORITY).toBe('权威记录：Newsletter 的 SQLite。Notion：异步副本，便于阅读与检索；在 Notion 中的修改不会回写。');
    expect(screen.getByText(/读取这一页不会访问 Notion/)).toBeVisible();
    expect(screen.getByText('个人事项（Todofy）不写入备份，只在这里与邮件中可见。')).toBeVisible();
  });

  it("counts each target's records by state, with its last confirmed write and its oldest wait", async () => {
    serve(world());
    show('#/backup');
    const editions = await section('简报库');
    const counts = within(editions.getByRole('list')).getAllByRole('listitem').map((item) => item.textContent);
    expect(counts).toEqual(['1●已同步', '2◆同步中', '1▲副本较旧', '1▲等待重试', '1◆待核对', '1■有冲突']);
    expect(editions.getByText('最早待同步').nextElementSibling).toHaveTextContent(/起，已等 5 天$/);
    const materials = await section('材料库');
    expect(within(materials.getByRole('list')).getAllByRole('listitem')[1]).toHaveTextContent('0○同步中');
  });

  it('lists the records that need attention, saying to check an unknown write before anything is created again', async () => {
    serve(world());
    show('#/backup');
    const rows = (await section('需要关注的记录')).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('简报库10月25日合成期刊 10/25▲等待重试');
    expect(rows[0]).toHaveTextContent('已尝试 3 次');
    expect(within(rows[0]!).getByRole('link', { name: '合成期刊 10/25' })).toHaveAttribute('href', '#/issues/00000000-0000-4000-8000-000000000025');
    expect(within(rows[0]!).getByRole('link', { name: '在 Notion 中打开' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(rows[1]).toHaveTextContent('自动写入暂停');
    expect(rows[3]).toHaveTextContent('材料库');
    expect(within(rows[3]!).queryByRole('link')).toBeNull();
    expect(rows[4]).toHaveTextContent('写入结果未确认：可能已产生副本，先核对，避免重复创建。');
    expect((await section('未能记入备份日志')).getByText('notion_research_import_failed')).toBeVisible();
  });

  it('says when the backup is off, and that the counts are what it copied before', async () => {
    serve(world({ '/api/v1/backupStatus': { ...fixture<Record<string, unknown>>('backup-status'), enabled: false } }));
    show('#/backup');
    expect(await screen.findByText('Notion 备份未启用')).toBeVisible();
    expect(screen.getByText(/下面是关闭之前写入的副本/)).toBeVisible();
  });
});
