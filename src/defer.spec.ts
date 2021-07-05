import { Defer } from './defer';

describe('utils/defer', () => {
  it('should resolve', async () => {
    const defer = new Defer<string>();
    expect(defer.isResolved).toBeFalsy();
    expect(defer.isRejected).toBeFalsy();
    defer.resolve('foo');
    const result = await defer.promise;
    expect(result).toEqual('foo');
    expect(defer.resolvedResult).toEqual('foo');
    expect(defer.isResolved).toBeTruthy();
    expect(defer.isRejected).toBeFalsy();
  });

  it('should reject', async () => {
    const defer = new Defer<string>();
    expect(defer.isResolved).toBeFalsy();
    expect(defer.isRejected).toBeFalsy();
    defer.reject(new Error('err'));
    expect(defer.isResolved).toBeFalsy();
    expect(defer.isRejected).toBeTruthy();
    try {
      await defer.promise;
      expect(true).toEqual(false);
    } catch (e) {
      expect(e.message).toEqual('err');
    }
    expect(defer.rejectedError).toEqual(new Error('err'));
  });

  it('should throw on second resolve', async () => {
    const defer = new Defer<string>();
    defer.resolve('foo');
    expect(() => defer.resolve('bar')).toThrow();
  });

  it('should have result null if none defined', async () => {
    const defer = new Defer<void>();
    defer.resolve();
    expect(defer.resolvedResult).toBe(null);
  });

  it('should throw on resolve after reject', (done) => {
    const defer = new Defer<string>();
    defer.reject(new Error('test'));
    try {
      defer.resolve('bar');
      done.fail('should haven thrown an error');
    } catch (e) {
      done();
    }
  });

  it('should throw on second reject', (done) => {
    const defer = new Defer<string>();
    defer.reject(new Error('test'));
    try {
      defer.reject(new Error('test2'));
      done.fail('should haven thrown an error');
    } catch (e) {
      done();
    }
  });

  it('should throw on reject after resolve', (done) => {
    const defer = new Defer<string>();
    defer.resolve('foo');
    try {
      defer.reject(new Error('test2'));
      done.fail('should haven thrown an error');
    } catch (e) {
      done();
    }
  });
});
