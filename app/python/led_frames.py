"""8×13 LED 矩陣的畫面。

每個畫面是 104 bytes（8 列 × 13 欄，逐列排列），每格亮度 0–7，
對應 sketch 裡的 matrix.setGrayscaleBits(3)。
"""

ROWS, COLS = 8, 13
MAX = 7


def _blank() -> list[list[int]]:
    return [[0] * COLS for _ in range(ROWS)]


def _to_bytes(grid: list[list[int]]) -> bytes:
    return bytes(max(0, min(MAX, v)) for row in grid for v in row)


def _from_art(art: list[str], level: int = MAX) -> list[list[int]]:
    grid = _blank()
    for r, line in enumerate(art):
        for c, ch in enumerate(line):
            if ch == "#":
                grid[r][c] = level
    return grid


def progress(done: float, blink: bool = True) -> bytes:
    """專注進度條：由左到右一欄一欄、每欄由下往上填滿，共 104 格。下一格會閃。"""
    done = max(0.0, min(1.0, done))
    total = ROWS * COLS
    filled = int(done * total)
    grid = _blank()
    for k in range(total):
        col, row = k // ROWS, ROWS - 1 - (k % ROWS)
        if k < filled:
            grid[row][col] = 5
        elif k == filled and blink:
            grid[row][col] = MAX
    return _to_bytes(grid)


_WARNING = [
    "#############",
    "#.....#.....#",
    "#.....#.....#",
    "#.....#.....#",
    "#.....#.....#",
    "#...........#",
    "#.....#.....#",
    "#############",
]


def warning(on: bool) -> bytes:
    """暫離：外框加驚嘆號，一亮一暗閃爍。"""
    return _to_bytes(_from_art(_WARNING) if on else _blank())


_SMILE = [
    ".............",
    "...##...##...",
    "...##...##...",
    ".............",
    ".#.........#.",
    "..#.......#..",
    "...#######...",
    ".............",
]


def smile() -> bytes:
    """休息中：笑臉。"""
    return _to_bytes(_from_art(_SMILE, level=5))


_PLAY = [
    ".............",
    ".....#.......",
    ".....##......",
    ".....###.....",
    ".....###.....",
    ".....##......",
    ".....#.......",
    ".............",
]


def idle(tick: int) -> bytes:
    """尚未開始：播放鍵，亮度慢慢呼吸。"""
    wave = [1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2]
    return _to_bytes(_from_art(_PLAY, level=wave[tick % len(wave)]))


def celebrate(tick: int) -> bytes:
    """專注完成：從中心往外擴散的方框。"""
    ring = tick % 4
    grid = _blank()
    for r in range(ROWS):
        for c in range(COLS):
            d = max(abs(r - 3.5), abs(c - 6) / 1.6)
            if abs(d - (ring + 0.5)) < 0.5:
                grid[r][c] = MAX
    return _to_bytes(grid)


if __name__ == "__main__":
    # 在電腦上預覽：python led_frames.py
    def show(name: str, data: bytes) -> None:
        print(name)
        for r in range(ROWS):
            print(" ".join(".:-=+*#@"[data[r * COLS + c]] for c in range(COLS)))
        print()

    show("progress 40%", progress(0.4))
    show("warning", warning(True))
    show("smile", smile())
    show("idle", idle(6))
    for t in range(4):
        show(f"celebrate {t}", celebrate(t))
