// ═══ Типы для плагинов ═══

/**
 * @typedef {Object} SymbolInfo
 * @property {string} id — уникальный ID (s0, s1, ...)
 * @property {string} kind — function, class, method, variable, interface, type
 * @property {string} name — имя символа
 * @property {string} sig — сигнатура (напр. "function parse(s: string): number")
 * @property {string} loc — локация "line:col-line:col"
 * @property {string[]} [deps] — ID символов, от которых зависит
 * @property {boolean} [exported] — экспортируется ли
 */

/**
 * @typedef {Object} FileFingerprint
 * @property {string} hash — усечённый SHA-256 (16 chars)
 * @property {SymbolInfo[]} symbols — все top-level символы
 * @property {string[]} imports — импорты (сжатые)
 * @property {number} tokenEstimate — примерное число токенов полного файла
 */

/**
 * @typedef {Object} AliasMap
 * @property {Object<string,string>} to — оригинал -> алиас
 * @property {Object<string,string>} from — алиас -> оригинал
 */

/**
 * @typedef {Object} LanguagePlugin
 * @property {string} languageId
 * @property {string[]} extensions
 * @property {function(string): FileFingerprint} fingerprint
 * @property {function(string, string): string|null} resolveSymbol — code, symbolId → body
 * @property {function(string, AliasMap): string} compress
 * @property {function(string, AliasMap): string} decompress
 * @property {function(string): string} stripComments
 * @property {function(string, string): string} diffSemantic — oldCode, newCode → unified diff
 */

export const TYPES = {}; // placeholder
