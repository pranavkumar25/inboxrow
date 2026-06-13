"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartPoint = {
  date: string;
  SENT: number;
  OPEN: number;
  CLICK: number;
  REPLY: number;
};

const SERIES: { key: keyof Omit<ChartPoint, "date">; color: string }[] = [
  { key: "SENT", color: "#3b82f6" },
  { key: "OPEN", color: "#6366f1" },
  { key: "CLICK", color: "#8b5cf6" },
  { key: "REPLY", color: "#22c55e" },
];

export function EventsChart({ data }: { data: ChartPoint[] }) {
  if (!data.length) {
    return (
      <p className="py-8 text-center text-sm text-neutral-400">
        No activity yet — events appear here once the campaign starts sending.
      </p>
    );
  }
  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="date" fontSize={11} stroke="#999" />
          <YAxis allowDecimals={false} fontSize={11} stroke="#999" />
          <Tooltip />
          <Legend />
          {SERIES.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
