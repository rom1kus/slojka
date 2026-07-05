export interface BrushParams {
  /** Диаметр в px документа. */
  size: number
  /** 0..1 — доля радиуса без спада мягкости. */
  hardness: number
  /** Непрозрачность штриха целиком (Photoshop opacity). 0..1 */
  opacity: number
  /** Насыщение одного даба (Photoshop flow). 0..1 */
  flow: number
  /** Шаг дабов как доля диаметра. */
  spacing: number
  /** Влияние нажима пера на размер. */
  pressureSize: boolean
  /** Влияние нажима пера на flow. */
  pressureFlow: boolean
  /** id зарегистрированного в движке типса (текстурная кисть из .kpp/.abr). */
  tipId?: string
}

export const DEFAULT_BRUSH: BrushParams = {
  size: 32,
  hardness: 0.8,
  opacity: 1,
  flow: 1,
  spacing: 0.12,
  pressureSize: true,
  pressureFlow: false,
}

export interface StrokePoint {
  x: number
  y: number
  /** 0..1; мышь даёт 0.5 (Pointer Events отдают 0.5 при отсутствии пера). */
  pressure: number
}

export interface Dab {
  x: number
  y: number
  size: number
  flow: number
}
