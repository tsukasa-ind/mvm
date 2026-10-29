//! 2つ目以降の起動 (single-instance) の保留。
//!
//! single-instance のコールバックは setup より前、`AppState` の登録前にも呼ばれうる。
//! また、フロントが `open-files` のリスナを登録する前に emit すると、イベントは失われる。
//! そのため、フロントが `get_startup` で起動時の状態を受け取るまでは起動引数を積んでおき、
//! `get_startup` で起動時の状態に合流させる。以後は直接処理して emit する。

use std::sync::Mutex;

pub struct LaunchQueue<T> {
    inner: Mutex<State<T>>,
}

struct State<T> {
    /// フロントが起動時の状態を受け取った後か
    ready: bool,
    pending: Vec<T>,
}

impl<T> LaunchQueue<T> {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(State {
                ready: false,
                pending: Vec::new(),
            }),
        }
    }

    /// 準備前なら積んで None を返す。準備後ならそのまま返すので、呼び出し元が処理する。
    pub fn push_or_pass(&self, launch: T) -> Option<T> {
        let mut inner = self.inner.lock().unwrap();
        if inner.ready {
            return Some(launch);
        }
        inner.pending.push(launch);
        None
    }

    /// 積まれていた起動を `merge` に渡し、準備完了にする。
    /// `merge` の実行中に届いた起動は `push_or_pass` で待たされ、合流の後に処理される (順序が逆転しない)。
    pub fn drain_into<R>(&self, merge: impl FnOnce(Vec<T>) -> R) -> R {
        let mut inner = self.inner.lock().unwrap();
        let pending = std::mem::take(&mut inner.pending);
        let result = merge(pending);
        inner.ready = true;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn launches_before_ready_are_merged_then_passed_through() {
        let queue = LaunchQueue::new();
        assert_eq!(queue.push_or_pass(1), None);
        assert_eq!(queue.push_or_pass(2), None);
        assert_eq!(queue.drain_into(|pending| pending), vec![1, 2]);
        assert_eq!(queue.push_or_pass(3), Some(3));
        // 2回目の取得 (StrictMode) では何も合流しない
        assert_eq!(queue.drain_into(|pending| pending), Vec::<i32>::new());
    }

    #[test]
    fn launch_during_merge_waits_until_ready() {
        let queue = Arc::new(LaunchQueue::new());
        queue.push_or_pass(1);
        let (started, wait) = std::sync::mpsc::channel();
        let racer = Arc::clone(&queue);
        let merged = queue.drain_into(|pending| {
            let handle = std::thread::spawn(move || {
                started.send(()).unwrap();
                racer.push_or_pass(2)
            });
            wait.recv().unwrap();
            std::thread::sleep(Duration::from_millis(50));
            (pending, handle)
        });
        assert_eq!(merged.0, vec![1]);
        // 合流中に届いた起動は積まれず、準備後の処理として返る
        assert_eq!(merged.1.join().unwrap(), Some(2));
    }
}
