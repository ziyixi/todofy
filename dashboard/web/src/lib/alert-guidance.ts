export interface AlertGuidance { explanation: string; next: string }

/** Explain observable facts and a useful next step; never guess an outage's cause. */
export function alertGuidance(code: string): AlertGuidance {
  switch (code) {
    case 'newsletter_unknown':
      return {
        explanation: '一些操作记录缺少最终完成结果。计数可能包含中断活动、采编步骤、Notion 写入或发信记录，也可能重叠；它不等于失败邮件数。当前是否运行、是否有在途任务见下方计数。',
        next: '不打算核对这批旧记录时，可以关闭本次提醒；需要重跑时，先核对实际邮件和 Notion 结果。',
      }
    case 'newsletter_paused':
      return { explanation: 'Newsletter 正在排空或已冻结，新任务暂时不会开始。', next: '打开 Fleet 查看发布阶段；确认发布完成或处理暂停原因后，通过对应发布操作恢复。' }
    case 'newsletter_unavailable':
      return { explanation: '最新观测未确认 Newsletter 进程可用。', next: '打开 Fleet 核对 Pod、进程和当前发布；恢复服务后刷新状态。' }
    case 'host_never_seen':
    case 'host_stale':
    case 'host_missing':
      return { explanation: '主机没有新鲜的观测回执，页面无法确认当前服务状态。', next: '打开 Fleet 看最后报告与系统服务状态，核对观察器和网络连接。' }
    case 'deployment_pending':
    case 'release_in_progress':
      return { explanation: '目标版本还没有完成实际运行核验，发布进行中不代表部署成功。', next: '打开 Fleet 对比目标和实际版本，再查看本次 GitHub Actions；长期未完成时处理对应发布错误。' }
    case 'release_failed':
    case 'release_held':
      return { explanation: '发布已经失败或暂停，正常升级尚未完成。', next: '打开 Fleet 查看发布请求和阶段，修复错误后继续原发布操作。' }
    case 'backup_stale':
    case 'backup_failed':
      return { explanation: '没有新的完整成功备份记录，部署成功不能替代数据备份。', next: '查看应用的备份状态和安全错误码，修复后请求一次备份；成功记录同步后该问题会恢复。' }
    case 'parse_failed':
    case 'delivery_failed':
    case 'endpoint_blocked':
      return { explanation: '邮件处理或目标投递出现了需要处理的记录。', next: '打开 Mail Hero 查看具体邮件和尝试记录，修复解析或目标配置后重试对应事件。' }
    default:
      return code.startsWith('daemon_')
        ? { explanation: '最新主机报告显示该系统服务状态异常或尚未确认。', next: '打开 Fleet 查看具体服务状态，处理对应服务后刷新观测。' }
        : { explanation: '监控发现了当前这项异常；详情中的时间、状态和计数说明已观察到的事实。', next: '先查看对应应用或流程详情；已处理或暂不需要跟进时，可以关闭当前提醒。' }
  }
}
