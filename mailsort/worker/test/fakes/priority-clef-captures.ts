/**
 * Real Workers AI numeric captures for the public synthetic PRIORITY_CASES with the candidate reading-cadence prompt.
 * One pair per fixture/model, replayed offline to check the confidence policy. These are not mailbox accuracy claims.
 * Flash's missing-deadline second view was captured for comparison; the production 0.4 first-view gate skips it.
 */
export interface PriorityClefCapture {
  readonly id: string;
  readonly model: string;
  readonly first: Readonly<Record<string, number>>;
  readonly second: Readonly<Record<string, number>>;
}

export const PRIORITY_CLEF_CAPTURES: readonly PriorityClefCapture[] = [
  {
    id: "today-confirmation-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0272, "p1": 0.8162, "p2": 0.0683, "p3": 0.0262, "p4": 0.0621},
    second: {"none": 0.0285, "p1": 0.8416, "p2": 0.0734, "p4": 0.0565},
  },
  {
    id: "tomorrow-project-zh",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0202, "p1": 0.8666, "p2": 0.0765, "p3": 0.0179, "p4": 0.0188},
    second: {"none": 0.0205, "p1": 0.8776, "p2": 0.084, "p4": 0.0179},
  },
  {
    id: "friday-monday-deadline-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0132, "p1": 0.825, "p2": 0.1185, "p3": 0.0241, "p4": 0.0192},
    second: {"none": 0.0136, "p1": 0.8427, "p2": 0.1192, "p3": 0.0245},
  },
  {
    id: "missing-deadline-zh",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0579, "p1": 0.2691, "p2": 0.518, "p3": 0.0444, "p4": 0.1106},
    second: {"none": 0.0656, "p1": 0.274, "p2": 0.5794, "p4": 0.081},
  },
  {
    id: "next-week-review-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0158, "p1": 0.2722, "p2": 0.5687, "p3": 0.1121, "p4": 0.0312},
    second: {"none": 0.017, "p1": 0.2964, "p2": 0.5754, "p3": 0.1112},
  },
  {
    id: "friday-next-week-form-zh",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0153, "p1": 0.1418, "p2": 0.6478, "p3": 0.1143, "p4": 0.0808},
    second: {"none": 0.0168, "p1": 0.1486, "p2": 0.7121, "p3": 0.1225},
  },
  {
    id: "important-policy-review-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0149, "p1": 0.1323, "p2": 0.5842, "p3": 0.1727, "p4": 0.0959},
    second: {"none": 0.0169, "p1": 0.1439, "p2": 0.6454, "p3": 0.1938},
  },
  {
    id: "technical-reading-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0091, "p1": 0.0076, "p2": 0.0679, "p3": 0.8202, "p4": 0.0952},
    second: {"none": 0.0089, "p2": 0.0715, "p3": 0.8424, "p4": 0.0772},
  },
  {
    id: "longform-reading-zh",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0098, "p1": 0.0063, "p2": 0.0633, "p3": 0.8921, "p4": 0.0285},
    second: {"none": 0.0099, "p2": 0.0547, "p3": 0.9047, "p4": 0.0307},
  },
  {
    id: "friday-reading-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0086, "p1": 0.0068, "p2": 0.0716, "p3": 0.8706, "p4": 0.0424},
    second: {"none": 0.0081, "p2": 0.0681, "p3": 0.8741, "p4": 0.0497},
  },
  {
    id: "saturday-reading-zh",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0052, "p1": 0.0039, "p2": 0.0364, "p3": 0.9424, "p4": 0.0121},
    second: {"none": 0.0048, "p2": 0.0321, "p3": 0.9525, "p4": 0.0106},
  },
  {
    id: "routine-delivery-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.012, "p1": 0.0057, "p2": 0.0162, "p3": 0.0138, "p4": 0.9523},
    second: {"none": 0.011, "p2": 0.0138, "p3": 0.0163, "p4": 0.9589},
  },
  {
    id: "optional-sale-countdown-zh",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0047, "p1": 0.0098, "p2": 0.0084, "p3": 0.011, "p4": 0.9661},
    second: {"none": 0.0048, "p1": 0.011, "p3": 0.0153, "p4": 0.9689},
  },
  {
    id: "routine-build-fyi-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0034, "p1": 0.0038, "p2": 0.0085, "p3": 0.0115, "p4": 0.9728},
    second: {"none": 0.0036, "p2": 0.0092, "p3": 0.0111, "p4": 0.9761},
  },
  {
    id: "expired-optional-event-zh",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0071, "p1": 0.0132, "p2": 0.0247, "p3": 0.0282, "p4": 0.9268},
    second: {"none": 0.0072, "p2": 0.0256, "p3": 0.0318, "p4": 0.9354},
  },
  {
    id: "stale-unresolved-obligation-en",
    model: "@cf/cloudflare/clef",
    first: {"none": 0.0107, "p1": 0.9243, "p2": 0.0344, "p3": 0.0124, "p4": 0.0182},
    second: {"none": 0.0109, "p1": 0.9365, "p2": 0.0366, "p4": 0.016},
  },
  {
    id: "today-confirmation-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0746, "p1": 0.7486, "p2": 0.0709, "p3": 0.034, "p4": 0.0719},
    second: {"none": 0.0747, "p1": 0.7775, "p2": 0.0745, "p4": 0.0733},
  },
  {
    id: "tomorrow-project-zh",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0318, "p1": 0.8068, "p2": 0.0767, "p3": 0.0371, "p4": 0.0476},
    second: {"none": 0.0357, "p1": 0.8341, "p2": 0.0819, "p4": 0.0483},
  },
  {
    id: "friday-monday-deadline-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0689, "p1": 0.6899, "p2": 0.1297, "p3": 0.048, "p4": 0.0635},
    second: {"none": 0.0782, "p1": 0.7126, "p2": 0.138, "p4": 0.0712},
  },
  {
    id: "missing-deadline-zh",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.1765, "p1": 0.2898, "p2": 0.3896, "p3": 0.0625, "p4": 0.0816},
    second: {"none": 0.1848, "p1": 0.3034, "p2": 0.4207, "p4": 0.0911},
  },
  {
    id: "next-week-review-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0374, "p1": 0.6894, "p2": 0.1777, "p3": 0.0503, "p4": 0.0452},
    second: {"none": 0.0389, "p1": 0.7245, "p2": 0.1829, "p3": 0.0537},
  },
  {
    id: "friday-next-week-form-zh",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0443, "p1": 0.3829, "p2": 0.4368, "p3": 0.0637, "p4": 0.0723},
    second: {"none": 0.0485, "p1": 0.4114, "p2": 0.4657, "p4": 0.0744},
  },
  {
    id: "important-policy-review-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0525, "p1": 0.4137, "p2": 0.3846, "p3": 0.0809, "p4": 0.0683},
    second: {"none": 0.0583, "p1": 0.4355, "p2": 0.4174, "p3": 0.0888},
  },
  {
    id: "technical-reading-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0259, "p1": 0.02, "p2": 0.0364, "p3": 0.8572, "p4": 0.0605},
    second: {"none": 0.0271, "p2": 0.0404, "p3": 0.8779, "p4": 0.0546},
  },
  {
    id: "longform-reading-zh",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0281, "p1": 0.0207, "p2": 0.0497, "p3": 0.8456, "p4": 0.0559},
    second: {"none": 0.0264, "p2": 0.0441, "p3": 0.8887, "p4": 0.0408},
  },
  {
    id: "friday-reading-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0229, "p1": 0.0205, "p2": 0.0422, "p3": 0.8539, "p4": 0.0605},
    second: {"none": 0.0189, "p2": 0.0282, "p3": 0.9146, "p4": 0.0383},
  },
  {
    id: "saturday-reading-zh",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0159, "p1": 0.0119, "p2": 0.0262, "p3": 0.9318, "p4": 0.0142},
    second: {"none": 0.0186, "p2": 0.0331, "p3": 0.9313, "p4": 0.017},
  },
  {
    id: "routine-delivery-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0459, "p1": 0.0188, "p2": 0.03, "p3": 0.048, "p4": 0.8573},
    second: {"none": 0.0464, "p2": 0.0274, "p3": 0.0357, "p4": 0.8905},
  },
  {
    id: "optional-sale-countdown-zh",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.1623, "p1": 0.1128, "p2": 0.0776, "p3": 0.0687, "p4": 0.5786},
    second: {"none": 0.1818, "p1": 0.1242, "p2": 0.0864, "p4": 0.6076},
  },
  {
    id: "routine-build-fyi-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0154, "p1": 0.0135, "p2": 0.0137, "p3": 0.018, "p4": 0.9394},
    second: {"none": 0.0159, "p2": 0.0142, "p3": 0.0173, "p4": 0.9526},
  },
  {
    id: "expired-optional-event-zh",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.1028, "p1": 0.0654, "p2": 0.0826, "p3": 0.0906, "p4": 0.6586},
    second: {"none": 0.1151, "p2": 0.0934, "p3": 0.0976, "p4": 0.6939},
  },
  {
    id: "stale-unresolved-obligation-en",
    model: "@cf/cloudflare/clef-flash",
    first: {"none": 0.0749, "p1": 0.694, "p2": 0.1209, "p3": 0.045, "p4": 0.0652},
    second: {"none": 0.0754, "p1": 0.7398, "p2": 0.1294, "p4": 0.0554},
  },
];
