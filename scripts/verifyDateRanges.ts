import { dayjs, TZ } from "../src/utils/dates";
import { getDayRangeTZ, getMonthRangeTZ } from "../src/utils/dateRange";

function log(label: string, data: any) {
  console.log(label, JSON.stringify(data, null, 2));
}

const now = dayjs().tz(TZ);

const dayRange = getDayRangeTZ(now.toDate(), TZ);
const monthRange = getMonthRangeTZ(now.toDate(), TZ);

const endOfMonthLocal = now.endOf("month").set("hour", 23).set("minute", 59).set("second", 0).set("millisecond", 0);
const includeEndOfMonth = endOfMonthLocal.toDate().getTime() >= monthRange.start.getTime() &&
  endOfMonthLocal.toDate().getTime() < monthRange.endExclusive.getTime();

log("dayRange", {
  start: dayRange.start.toISOString(),
  endExclusive: dayRange.endExclusive.toISOString(),
});

log("monthRange", {
  start: monthRange.start.toISOString(),
  endExclusive: monthRange.endExclusive.toISOString(),
  includesEndOfMonth23h59: includeEndOfMonth,
});
