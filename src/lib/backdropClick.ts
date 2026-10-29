/** 押してから離すまでにこれ以上動いたら、クリックではなくドラッグ (パン) とみなす */
export const CLICK_MOVE_TOLERANCE_PX = 5;

export type BackdropPointer = {
  x: number;
  y: number;
  /** 背景 (拡大対象のパネルやボタン以外) の上か */
  onBackdrop: boolean;
};

/**
 * 背景のクリックとしてモーダルを閉じてよいか。
 * 押した位置と離した位置の両方が背景で、その間にほとんど動いていない場合だけ閉じる。
 * パネルから背景へのドラッグや、背景でのパン操作の後に発火する click では閉じない。
 */
export const isBackdropClick = (down: BackdropPointer | null, click: BackdropPointer): boolean => {
  if (down === null || !down.onBackdrop || !click.onBackdrop) return false;
  return Math.hypot(click.x - down.x, click.y - down.y) <= CLICK_MOVE_TOLERANCE_PX;
};
