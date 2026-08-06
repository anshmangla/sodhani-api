export function lttb<T>(
  data: T[],
  threshold: number,
  xAccessor: (item: T) => number,
  yAccessor: (item: T) => number
): T[] {
  const dataLength = data.length;
  if (threshold >= dataLength || threshold === 0) {
    return data;
  }

  const sampled: T[] = [];
  let sampledIndex = 0;

  // Bucket size. Leave room for start and end data points
  const every = (dataLength - 2) / (threshold - 2);

  let a = 0; // Initially a is the first point in the triangle
  let maxAreaPoint = {} as T;
  let maxArea: number;
  let area: number;
  let nextA: number = 0;

  sampled[sampledIndex++] = data[a]; // Always add the first point

  for (let i = 0; i < threshold - 2; i++) {
    // Calculate point average for next bucket (containing c)
    let avgX = 0;
    let avgY = 0;
    let avgRangeStart = Math.floor((i + 1) * every) + 1;
    let avgRangeEnd = Math.floor((i + 2) * every) + 1;
    avgRangeEnd = avgRangeEnd < dataLength ? avgRangeEnd : dataLength;
    
    const avgRangeLength = avgRangeEnd - avgRangeStart;

    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += xAccessor(data[j]);
      avgY += yAccessor(data[j]);
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    // Get the range for this bucket
    let rangeOffs = Math.floor((i + 0) * every) + 1;
    let rangeTo = Math.floor((i + 1) * every) + 1;

    // Point a
    const pointAX = xAccessor(data[a]);
    const pointAY = yAccessor(data[a]);

    maxArea = -1;

    for (let j = rangeOffs; j < rangeTo; j++) {
      area =
        Math.abs(
          (pointAX - avgX) * (yAccessor(data[j]) - pointAY) -
            (pointAX - xAccessor(data[j])) * (avgY - pointAY)
        ) * 0.5;
      
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = data[j];
        nextA = j;
      }
    }

    sampled[sampledIndex++] = maxAreaPoint;
    a = nextA;
  }

  sampled[sampledIndex++] = data[dataLength - 1]; // Always add last

  return sampled;
}
