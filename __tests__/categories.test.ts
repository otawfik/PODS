import { getUniversityFromEmail, isEduEmail } from '../src/constants/categories';

// Keep in step with public.university_for_email (supabase/migrations) —
// the server stores the value; the app only displays it.
describe('getUniversityFromEmail', () => {
  it.each([
    ['alice@bu.edu', 'Boston University'],
    ['Alice@BU.EDU', 'Boston University'],
    ['carol@cs.bu.edu', 'Boston University'],
    ['dan@mit.edu', 'MIT'],
    ['erin@foo.edu', 'FOO University'],
    ['frank@cs.foo.edu', 'FOO University'],
    ['nobody', 'Unknown University'],
  ])('%s → %s', (email, expected) => {
    expect(getUniversityFromEmail(email)).toBe(expected);
  });
});

describe('isEduEmail', () => {
  it('accepts .edu and rejects other domains', () => {
    expect(isEduEmail('a@bu.edu')).toBe(true);
    expect(isEduEmail('a@gmail.com')).toBe(false);
    expect(isEduEmail('a@bu.edu.evil.com')).toBe(false);
  });
});
