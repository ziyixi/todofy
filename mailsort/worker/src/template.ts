/**
 * The built-in template of recommended labels (../../docs/design.md §3.2): fifteen common categories of personal mail,
 * none of them anyone's own (no sender, address or person), that the owner can import with one click
 * (ImportRules with `use_template`, previewed first) and then adjust.
 *
 * Each description is written for the decision model, which reads `path: description` for every label on every call:
 * one language (Chinese), one sentence, 60-120 characters (the "the template" tests of test/import.test.ts hold them
 * to it), saying what belongs there and, where two labels are close, what does not. Trust labels are transactional
 * only: a bank's or a broker's own marketing belongs to 购物/促销, so a look-alike promotion can never borrow a trust
 * label's standing.
 * Trust labels are only ever applied by a rule whose mail passed DMARC; the model may only suggest them.
 */

export interface TemplateLabel {
  /** The path below 分拣/. */
  readonly path: string;
  readonly description: string;
  readonly trust: boolean;
  readonly keepInInbox: boolean;
  readonly sensitive: boolean;
}

const label = (path: string, description: string, flags: Partial<Pick<TemplateLabel, 'trust' | 'keepInInbox' | 'sensitive'>> = {}): TemplateLabel => ({
  path,
  description,
  trust: flags.trust === true,
  keepInInbox: flags.keepInInbox === true,
  sensitive: flags.sensitive === true,
});

export const LABEL_TEMPLATE: readonly TemplateLabel[] = [
  label('开发/CI通知', '代码托管与持续集成平台自动发送的通知：构建成功或失败、拉取请求与议题动态、代码评审请求、依赖安全告警与新版本发布提醒，多为机器自动生成。'),
  label('开发/平台工具', '开发者平台与云服务账户的运营邮件：域名与证书续期、用量与额度提醒、服务变更与停用公告、接口密钥与计费说明，不含代码构建通知。'),
  label('金融/投资', '券商、基金和投资账户发出的交易性邮件：成交与持仓确认、月度对账单、分红与年度税表、资金划转到账，不含任何投资理财产品的营销推广。', { trust: true }),
  label('金融/银行支付', '银行、信用卡和支付平台发出的交易性邮件：消费与转账提醒、账单与还款通知、对账单、账户资料变动，不含这些机构自己发出的营销推广。', { trust: true }),
  label('账号安全', '各类网站和应用的账号安全通知：登录验证码、新设备或新地点登录提醒、密码重置、两步验证设置变更，以及可疑活动和异常登录警告。', { trust: true, keepInInbox: true }),
  label('政府法律', '政府机构、法院和律师的正式来函：税务、签证移民、证件办理、社会保险、交通违章、法律文书与合同，以及官方截止日期和办理进度提醒。', { trust: true, keepInInbox: true }),
  label('购物/订单物流', '网购订单的交易邮件：下单确认、付款收据、发货与物流跟踪、快递柜取件码、退货退款进度与售后处理，不含商家和平台发来的促销广告。'),
  label('购物/促销', '商家和品牌的营销邮件：促销折扣、优惠券、新品推荐、会员活动与积分兑换，也包括银行、券商和支付平台自己发出的产品推广与优惠活动。'),
  label('订阅收据', '软件、流媒体与会员服务的订阅扣费收据和续订提醒：月度或年度账单、免费试用到期、价格调整，以及订阅开通、升级与取消的确认。'),
  label('出行', '出行预订与行程安排：机票、火车票、酒店、租车的预订确认与变更，值机和登机提醒，行程单与发票，以及航空公司与酒店会员的积分动态。'),
  label('生活/账单住房', '家庭日常账单与住房事务：水电燃气、网络和话费、房租与物业费、房屋保险、维修与搬家预约，以及各类生活缴费到期与自动扣款提醒。'),
  label('生活/汽车', '车辆相关邮件：车险续保与理赔、保养与维修预约、年检与车辆登记、厂商召回通知，以及充电、加油、停车和道路通行等会员账户的动态。'),
  label('生活/医疗', '医疗与健康服务的来信：医院和诊所的预约与改期、检查结果通知、处方与药房取药提醒、医保与理赔说明，以及健康管理账户的消息。', { trust: true, sensitive: true }),
  label('求职', '求职与招聘相关邮件：职位申请确认、面试邀请与时间安排、招聘方或猎头的来信、笔试与背景调查、录用通知，以及招聘网站推送的职位推荐。'),
  label('学校与社群', '学校、课程与社群的来信：课程安排与成绩通知、学术会议与期刊投稿、校友会和兴趣社团的活动，以及论坛、邮件组和社区的讨论摘要。'),
];
