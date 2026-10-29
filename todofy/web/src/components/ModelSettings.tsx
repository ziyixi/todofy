import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { GetModelSettingsResponse } from '@ziyixi/proto/todofy/ui/v1/todofy_ui_service_pb';
import { todofy, newRequestId } from '../api/client';
import { Button, ErrorPanel, Loading, Section } from './ui';

const PROVIDERS: Readonly<Record<string, string>> = {
  codex: 'Codex 订阅', openai: 'OpenAI API', anthropic: 'Claude API', google: 'Gemini API',
};

function Choices({ data }: { data: GetModelSettingsResponse }) {
  const cache = useQueryClient();
  const settings = data.settings!;
  const [email, setEmail] = useState(settings.emailModel);
  const [report, setReport] = useState(settings.reportModel);
  const save = useMutation({
    mutationFn: () =>
      todofy.updateModelSettings({
        settings: { name: 'modelSettings', emailModel: email, reportModel: report },
        etag: settings.etag,
        updateMask: { paths: ['email_model', 'report_model'] },
        requestId: newRequestId(),
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['model-settings'] });
      void cache.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const options = data.models.filter((model) => model.kind === 'text');
  const choices = (selected: string) => (
    <>
      {!options.some((model) => model.id === selected) && (
        <option value={selected} disabled>{selected} · 目录不可用</option>
      )}
      {options.map((model) => (
        <option key={model.id} value={model.id} disabled={!model.configured}>
          {model.displayName || model.id} · {PROVIDERS[model.provider] || model.provider} ({model.id})
          {model.configured ? '' : ' · 未配置'}
        </option>
      ))}
    </>
  );
  const configured = (selected: string) => options.some((model) => model.id === selected && model.configured);
  return (
    <div className="stack">
      <label>
        逐封邮件摘要
        <select value={email} onChange={(event) => setEmail(event.target.value)}>
          {choices(email)}
        </select>
      </label>
      <label>
        日报与推荐
        <select value={report} onChange={(event) => setReport(event.target.value)}>
          {choices(report)}
        </select>
      </label>
      <p className="muted small">
        只影响之后的新计算；已完成的邮件和日报保留。所有模型共用现有的每日 token 预算。
        Codex 使用订阅，OpenAI、Claude 和 Gemini 按 API 计费，费用见 Model Router。Codex 或 OpenAI API 失败时不会改用 Gemini。
      </p>
      {save.isError && <ErrorPanel error={save.error} />}
      <Button
        onClick={() => save.mutate()}
        disabled={save.isPending || !configured(email) || !configured(report) || (email === settings.emailModel && report === settings.reportModel)}
      >
        {save.isPending ? '保存中…' : '保存模型'}
      </Button>
      {save.isSuccess && <span className="tone-ok small">已保存</span>}
    </div>
  );
}
export function ModelSettings() {
  const query = useQuery({
    queryKey: ['model-settings'],
    queryFn: () => todofy.getModelSettings({}),
    staleTime: 60000,
  });
  return (
    <Section title="摘要模型">
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <Choices key={query.data.settings?.etag} data={query.data} />
      )}
    </Section>
  );
}
