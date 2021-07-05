import { Debouncer } from './debouncer';
import {sleep} from './sleep';

describe('utils/debouncer', () => {
  it('should not trigger before start', async () => {
    let called = false;
    new Debouncer(() => {
      called = true;
    }, 10);
    await sleep(20);
    expect(called).toBeFalsy();
  });

  it('should trigger after start', async () => {
    let called = false;
    const debouncer = new Debouncer(() => {
      called = true;
    }, 10);
    debouncer.start();
    await sleep(20);
    expect(called).toBeTruthy();
  });

  it('should delay trigger after bounce', async () => {
    let called = false;
    const debouncer = new Debouncer(() => {
      called = true;
    }, 20);
    debouncer.start();
    await sleep(10);
    debouncer.bounce();
    await sleep(15);
    expect(called).toBeFalsy();
    await sleep(5);
    expect(called).toBeTruthy();
  });

  it('should cancel trigger after clear', async () => {
    let called = false;
    const debouncer = new Debouncer(() => {
      called = true;
    }, 20);
    debouncer.start();
    await sleep(10);
    debouncer.clear();
    await sleep(15);
    expect(called).toBeFalsy();
  });

  it('should trigger on flush', async () => {
    let called = false;
    const debouncer = new Debouncer(() => {
      called = true;
    }, 20);
    debouncer.start();
    await sleep(5);
    debouncer.flush();
    expect(called).toBeTruthy();
  });
});
