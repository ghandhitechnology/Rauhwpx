export class SerializedStateWriter {
  #write;
  #onError;
  #queue = Promise.resolve();

  constructor({ write, onError }) {
    this.#write = write;
    this.#onError = onError;
  }

  enqueue(snapshot) {
    const next = this.#queue.then(() => this.#write(snapshot));
    this.#queue = next.catch((error) => {
      this.#onError(error);
    });
    return this.#queue;
  }
}
