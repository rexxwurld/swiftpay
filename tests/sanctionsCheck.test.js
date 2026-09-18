// tests/sanctionsCheck.test.js
describe('screenName (dev stub)', () => {
  afterEach(() => jest.resetModules());

  it('flags a name on the dev denylist, case-insensitively', () => {
    process.env.SANCTIONS_DENYLIST_DEV = 'John Doe, Jane Smith';
    jest.resetModules();
    const { screenName } = require('../src/utils/sanctionsCheck');
    expect(screenName('john doe').hit).toBe(true);
    expect(screenName('JANE SMITH').hit).toBe(true);
  });

  it('does not flag a name absent from the denylist', () => {
    process.env.SANCTIONS_DENYLIST_DEV = 'John Doe';
    jest.resetModules();
    const { screenName } = require('../src/utils/sanctionsCheck');
    expect(screenName('Someone Else').hit).toBe(false);
  });

  it('handles an empty/unset denylist safely', () => {
    delete process.env.SANCTIONS_DENYLIST_DEV;
    jest.resetModules();
    const { screenName } = require('../src/utils/sanctionsCheck');
    expect(screenName('Anyone').hit).toBe(false);
    expect(screenName('').hit).toBe(false);
  });
});
