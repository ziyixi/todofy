import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { GetModelSettingsResponse } from '@ziyixi/proto/todofy/ui/v1/todofy_ui_service_pb';
import { todofy, newRequestId } from '../api/client';
import { Button, ErrorPanel, Loading, Section } from './ui';

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
  const options = data.models.filter((model) => model.configured && model.kind === 'text');
  return (
    <div className="stack">
      <label>
        逐封邮件摘要
        <select value={email} onChange={(event) => setEmail(event.target.value)}>
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName || model.id}{model.provider ? ` · ${model.provider}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        日报与推荐
        <select value={report} onChange={(event) => setReport(event.target.value)}>
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName || model.id}{model.provider ? ` · ${model.provider}` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        只影响之后的新计算；已完成的邮件和日报保留。用量计入现有的每日 token 预算。
      </p>
      {save.isError && <ErrorPanel error={save.error} />}
      <Button
        onClick={() => save.mutate()}
        disabled={save.isPending || (email === settings.emailModel && report === settings.reportModel)}
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
