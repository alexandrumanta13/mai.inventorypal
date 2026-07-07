import { FilterValidator } from './filter.validator';

describe('FilterValidator typo detection', () => {
  let validator: FilterValidator;

  beforeEach(() => {
    validator = new FilterValidator();
  });

  it('suggests corrections for common provider domain typos', () => {
    expect(validator.validate('client@gamil.com')).toMatchObject({
      hasSuggestedCorrection: true,
      suggestedEmail: 'client@gmail.com',
    });

    expect(validator.validate('client@yahoo.con')).toMatchObject({
      hasSuggestedCorrection: true,
      suggestedEmail: 'client@yahoo.com',
    });

    expect(validator.validate('client@gmail.con')).toMatchObject({
      hasSuggestedCorrection: true,
      suggestedEmail: 'client@gmail.com',
    });
  });

  it('does not flag valid country-code domains as typo candidates', () => {
    expect(validator.validate('client@yahoo.it')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@hotmail.fr')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@proton.me')).toMatchObject({
      hasSuggestedCorrection: false,
    });
  });

  it('does not force arbitrary domains into common providers', () => {
    expect(validator.validate('client@jindouyun.cn')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@moldtelecom.md')).toMatchObject({
      hasSuggestedCorrection: false,
    });
  });

  it('does not flag legitimate alternate provider domains as typo candidates', () => {
    expect(validator.validate('client@ymail.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@me.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@email.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@onmail.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });
  });

  it('does not flag unrelated real domains as provider typos', () => {
    expect(validator.validate('client@foxmail.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@cov.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@my.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });

    expect(validator.validate('client@gma.com')).toMatchObject({
      hasSuggestedCorrection: false,
    });
  });

  it('suggests local-part corrections when customer name strongly matches', () => {
    expect(
      validator.suggestNameLocalPartCorrection('catalina.dmitru@gmail.com', {
        firstName: 'Catalina',
        lastName: 'Dumitru',
      }),
    ).toMatchObject({
      suggestedEmail: 'catalina.dumitru@gmail.com',
      confidence: 'high',
    });

    expect(
      validator.suggestNameLocalPartCorrection('catalinadmitru@gmail.com', {
        firstName: 'Catalina',
        lastName: 'Dumitru',
      }),
    ).toMatchObject({
      suggestedEmail: 'catalinadumitru@gmail.com',
    });
  });

  it('does not suggest local-part corrections for ambiguous customer names', () => {
    expect(
      validator.suggestNameLocalPartCorrection('catalina_frmusika@gmail.com', {
        firstName: 'Catalina',
        lastName: 'Dumitru',
      }),
    ).toBeNull();

    expect(
      validator.suggestNameLocalPartCorrection('frmusika@gmail.com', {
        firstName: 'Catalina',
        lastName: 'Dumitru',
      }),
    ).toBeNull();
  });
});
