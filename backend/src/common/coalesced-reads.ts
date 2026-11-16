interface ReadGroup<T> {
  pending?: { run: () => Promise<void>; promise: Promise<T> };
}

export class CoalescedReads<T> {
  private readonly groups = new Map<string, ReadGroup<T>>();

  read(key: string, work: () => Promise<T>): Promise<T> {
    const group = this.groups.get(key);
    if (group?.pending) return group.pending.promise;
    if (!group && this.groups.size >= 128) return work();

    let run!: () => Promise<void>;
    const promise = new Promise<T>((resolve, reject) => {
      run = () => Promise.resolve().then(work).then(resolve, reject);
    });
    if (group) {
      group.pending = { run, promise };
    } else {
      const nextGroup = { pending: { run, promise } };
      this.groups.set(key, nextGroup);
      setImmediate(() => void this.drain(key, nextGroup));
    }
    return promise;
  }

  private async drain(key: string, group: ReadGroup<T>): Promise<void> {
    while (group.pending) {
      const pending = group.pending;
      // Close the group before starting the database read so late callers get a later snapshot.
      group.pending = undefined;
      await pending.run();
    }
    this.groups.delete(key);
  }
}
