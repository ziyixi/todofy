import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { DeviceStatusSchema } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { FakeServer, HOUR, NOW, visit, settle } from './test/fakeServer.ts'
import { buttonNamed, open, testHost, toastText } from './test/helpers.ts'

const NEW = '00000000-0000-4000-8000-000000000001'
const OLD = '00000000-0000-4000-8000-000000000002'
const EMPTY = '00000000-0000-4000-8000-000000000003'

function connections(): FakeServer {
  const fake = new FakeServer()
  fake.status = { devices: [
    create(DeviceStatusSchema, { deviceId: OLD, label: 'iPhone · Orion', mobile: true, extensionVersion: '1', hasRecords: true, lastHeartbeatTime: timestampFromMs(NOW - 2 * 365 * 24 * HOUR) }),
    create(DeviceStatusSchema, { deviceId: EMPTY, label: 'iPhone · Orion', mobile: true, extensionVersion: '2', hasRecords: false, lastHeartbeatTime: timestampFromMs(NOW - HOUR) }),
    create(DeviceStatusSchema, { deviceId: NEW, label: 'iPhone · Orion', mobile: true, extensionVersion: '3', hasRecords: true, lastHeartbeatTime: timestampFromMs(NOW) }),
  ] }
  fake.visits = [visit('old-page', [['09:00', '09:10']], { deviceId: OLD, deviceLabel: 'iPhone · Orion' })]
  return fake
}

it('folds same-name installs under the latest without hiding historical device IDs from the timeline', async () => {
  const fake = connections()
  fake.status = { ...fake.status, devices: fake.status.devices?.map((device) => device.deviceId === NEW ? create(DeviceStatusSchema, { ...device, extensionVersion: '1' }) : device) }
  const root = await open(fake, '/settings')
  const groups = root.querySelectorAll('.device-groups > li')
  expect(groups).toHaveLength(1)
  expect(groups[0]?.querySelector('.facts')?.textContent).toContain('版本 1')
  const history = groups[0]?.querySelector('details')
  expect(history?.open).toBe(false)
  expect(history?.querySelector('summary')?.textContent).toBe('同名旧连接（2）')
  const oldLink = history?.querySelector<HTMLAnchorElement>(`a[href="/?device=${OLD}"]`)
  expect(oldLink).not.toBeNull()
  oldLink?.click()
  await settle()
  expect(root.querySelector<HTMLSelectElement>('#timeline-device')?.value).toBe(OLD)
  expect(root.querySelector('.day-summary')?.textContent).toContain('1 个页面')
  expect(fake.searches('/api/v1/pages/-/visits').at(-1)?.searchParams.get('device_id')).toBe(OLD)
  expect([...root.querySelectorAll('#timeline-device option')].map((node) => node.textContent)).toEqual([
    '全部设备', 'iPhone · Orion · 1 · 000002', 'iPhone · Orion · 2', 'iPhone · Orion · 1 · 000001',
  ])
})

it('removes an empty test connection without deleting another installation’s records', async () => {
  const fake = connections()
  const host = testHost(false)
  const root = await open(fake, '/settings', host)
  buttonNamed(root, '移除空连接 iPhone · Orion 2').click()
  expect(host.asked).toEqual([])
  expect(fake.calls.filter((item) => item.method === 'DELETE')).toHaveLength(0)
  buttonNamed(root, '确认移除').click()
  await settle()
  const call = fake.calls.find((item) => item.method === 'DELETE')
  expect(call?.path).toMatch(new RegExp(`/api/v1/devices/${EMPTY}\\?request_id=[0-9a-f-]{36}$`))
  expect(call?.headers['x-csrf-token']).toBe('1')
  expect(fake.status.devices?.map((item) => item.deviceId)).toEqual([OLD, NEW])
  expect(fake.visits).toHaveLength(1)
  expect(root.querySelector('.device-history')?.textContent).toContain('版本 1')
  expect(root.querySelector('.device-history')?.textContent).not.toContain('版本 2')
})

it('offers no empty-connection removal for recorded, pending or legacy unknown state', async () => {
  const fake = connections()
  const pending = create(DeviceStatusSchema, { deviceId: EMPTY, label: 'Pending', hasRecords: false, queuedCount: 2 })
  const unknown = create(DeviceStatusSchema, { deviceId: NEW, label: 'Old server' })
  fake.status = { devices: [fake.status.devices![0]!, pending, unknown] }
  const root = await open(fake, '/settings')
  expect(root.querySelectorAll('.device-actions button')).toHaveLength(0)
})

it('cancels inline removal without a request or native confirmation', async () => {
  const fake = connections()
  const host = testHost(false)
  const root = await open(fake, '/settings', host)
  const clear = buttonNamed(root, '移除空连接 iPhone · Orion 2')
  clear.click()
  expect(clear.hidden).toBe(true)
  buttonNamed(root, '取消').click()
  expect(clear.hidden).toBe(false)
  expect(host.asked).toEqual([])
  expect(fake.calls.filter((item) => item.method === 'DELETE')).toHaveLength(0)
  expect(fake.status.devices).toHaveLength(3)
})

it('keeps inline removal usable after a server refusal and only retries on another click', async () => {
  const fake = connections()
  const root = await open(fake, '/settings')
  buttonNamed(root, '移除空连接 iPhone · Orion 2').click()
  fake.status = { ...fake.status, devices: fake.status.devices?.map((item) => item.deviceId === EMPTY ? create(DeviceStatusSchema, { ...item, queuedCount: 1 }) : item) }
  buttonNamed(root, '确认移除').click()
  await settle()
  expect(toastText(root)).toBe('这个连接有记录或待上传内容，不能移除')
  expect(buttonNamed(root, '确认移除').disabled).toBe(false)
  expect(fake.calls.filter((item) => item.method === 'DELETE')).toHaveLength(1)
  await settle()
  expect(fake.calls.filter((item) => item.method === 'DELETE')).toHaveLength(1)
  fake.status = { ...fake.status, devices: fake.status.devices?.map((item) => item.deviceId === EMPTY ? create(DeviceStatusSchema, { ...item, queuedCount: 0 }) : item) }
  buttonNamed(root, '确认移除').click()
  await settle()
  expect(fake.calls.filter((item) => item.method === 'DELETE')).toHaveLength(2)
  expect(fake.status.devices?.map((item) => item.deviceId)).toEqual([OLD, NEW])
  expect(fake.visits).toHaveLength(1)
})
