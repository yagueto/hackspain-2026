import { CalculatedRoute, Coordinates } from '../models/operations';

export interface RoutePlan {
  route: CalculatedRoute;
  lengths: readonly number[];
  totalLength: number;
}

export function prepareRoute(route: CalculatedRoute): RoutePlan {
  const radians = Math.PI / 180;
  const lengths = route.path.slice(1).map((point, index) => {
    const previous = route.path[index];
    const a =
      Math.sin(((point.lat - previous.lat) * radians) / 2) ** 2 +
      Math.cos(previous.lat * radians) *
        Math.cos(point.lat * radians) *
        Math.sin(((point.lng - previous.lng) * radians) / 2) ** 2;
    return 12742000 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  });
  return { route, lengths, totalLength: lengths.reduce((sum, length) => sum + length, 0) };
}

export function advanceRoute(
  plan: RoutePlan,
  elapsedSeconds: number,
): { position: Coordinates; remaining: CalculatedRoute; completed: boolean } {
  const { route, lengths, totalLength } = plan;
  const fraction =
    route.durationSeconds > 0
      ? Math.min(1, Math.max(0, elapsedSeconds / route.durationSeconds))
      : 1;
  if (fraction >= 1 || totalLength === 0) {
    const position = route.path[route.path.length - 1];
    return {
      position,
      remaining: { path: [position], durationSeconds: 0, distanceMeters: 0 },
      completed: true,
    };
  }
  let travelled = totalLength * fraction;
  let index = 0;
  while (index < lengths.length - 1 && travelled >= lengths[index]) {
    travelled -= lengths[index++];
  }
  const ratio = lengths[index] ? travelled / lengths[index] : 0;
  const from = route.path[index];
  const to = route.path[index + 1];
  const position = {
    lat: from.lat + (to.lat - from.lat) * ratio,
    lng: from.lng + (to.lng - from.lng) * ratio,
  };
  return {
    position,
    completed: false,
    remaining: {
      path: [position, ...route.path.slice(index + 1)],
      durationSeconds: Math.max(0, route.durationSeconds - elapsedSeconds),
      distanceMeters: route.distanceMeters * (1 - fraction),
    },
  };
}
