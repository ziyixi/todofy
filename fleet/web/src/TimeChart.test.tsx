import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { TimeChart, type ChartLine } from './TimeChart.tsx';

afterEach(cleanup);

const GRID = { start: new Date(2026, 9, 2, 0, 0).getTime(), stepSeconds: 300, count: 8 };
const CPU: ChartLine = { key: 'cpu', name: '使用', color: '#2a78d6', values: [10, 12, null, 14, null, null, 20, 22] };
const IOWAIT: ChartLine = { key: 'io', name: 'I/O 等待', color: '#eb6834', values: [1, 1, 1, 1, 1, 1, 1, null] };

function chart(lines: ChartLine[], props: Partial<Parameters<typeof TimeChart>[0]> = {}) {
  return render(<TimeChart title="CPU 使用率" unit="percent" grid={GRID} range="day" lines={lines} {...props} />);
}

describe('time chart', () => {
  it('draws one path per run and a dot for a lone step, never bridging a gap', () => {
    const { container } = chart([CPU]);
    const runs = container.querySelectorAll('g[data-run="cpu"]');
    expect(runs).toHaveLength(2);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
  });
  it('names a single series by its title and latest value, with no legend box', () => {
    chart([CPU]);
    expect(screen.queryByRole('list', { name: 'CPU 使用率图例' })).toBeNull();
    expect(screen.getByText('22.0%')).toBeVisible();
  });
  it('lists every series in a legend with its latest value', () => {
    chart([CPU, IOWAIT]);
    const legend = screen.getByRole('list', { name: 'CPU 使用率图例' });
    expect(within(legend).getByText('使用').nextElementSibling).toHaveTextContent('22.0%');
    expect(within(legend).getByText('I/O 等待').nextElementSibling).toHaveTextContent('1.0%');
  });
  it('reads exact values by keyboard, including a gap as no data', async () => {
    const user = userEvent.setup();
    chart([CPU, IOWAIT]);
    const plot = screen.getByRole('group', { name: /CPU 使用率，24 小时/ });
    await user.tab();
    expect(plot).toHaveFocus();
    const tooltip = (): HTMLElement => plot.querySelector('.tooltip') as HTMLElement;
    expect(tooltip()).toHaveTextContent('22.0%');
    expect(tooltip()).toHaveTextContent('无数据');
    await user.keyboard('{Home}');
    expect(tooltip()).toHaveTextContent('10.0%');
    expect(tooltip()).toHaveTextContent('00:00');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tooltip()).toHaveTextContent('无数据');
    await user.keyboard('{Escape}');
    expect(plot.querySelector('.tooltip')).toBeNull();
  });
  it('shows the peak of a coarse step on hover', () => {
    const { container } = render(
      <TimeChart title="内存" unit="percent" range="week" grid={{ ...GRID, stepSeconds: 3600 }}
        lines={[{ ...CPU, max: [15, 12, null, 14, null, null, 30, 25] }]} />,
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    fireEvent.pointerMove(svg, { clientX: 640 });
    expect(container.querySelector('.tooltip')).toHaveTextContent('峰值 25.0%');
  });
  it('keeps the frame and says so when the range has no data', () => {
    chart([{ ...CPU, values: [null, null, null, null, null, null, null, null] }]);
    expect(screen.getByText('此范围内没有数据')).toBeVisible();
    expect(screen.getByRole('group', { name: /CPU 使用率/ })).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByText('CPU 使用率数据表')).toBeNull();
  });
  it('offers the same values as a table, built when opened', async () => {
    const user = userEvent.setup();
    chart([CPU, IOWAIT]);
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(screen.getByText('CPU 使用率数据表'));
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(1 + 8);
    expect(rows[1]).toHaveTextContent('10.0%');
  });
});
