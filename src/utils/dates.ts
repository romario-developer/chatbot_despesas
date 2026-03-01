import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import customParseFormat from "dayjs/plugin/customParseFormat";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";

// Carrega os plugins essenciais para manipulação financeira de tempo
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

// A ÚNICA FONTE DA VERDADE PARA O FUSO HORÁRIO NO SISTEMA
export const TZ = "America/Bahia";

// Define o fuso padrão para todas as instâncias do dayjs criadas a partir daqui
dayjs.tz.setDefault(TZ);

export { dayjs };