// The running stride from motion capture (CMU Graphics Lab Motion Capture
// Database, mocap.cs.cmu.edu – free to use; the recorded motion itself isn't
// included), pooled over 19 steps of 10 runs at ~3.3 m/s: steps a second,
// how much lower the hips run (share of their standing height), the share of
// the stride a foot is on the ground and the phase it's centred on, and each
// angle of the figure through a stride – its low and high, and its shape
// between them (0..1) as [mean, cos 1, sin 1, ... cos 4, sin 4] over the
// stride's phase (the left thigh furthest forward at pi/2; a leg's or arm's
// curve is the left one – the right runs half a stride on; bob is a share of
// hip height). Written by scripts/learn/learn-gait.mjs – don't edit by hand.
export const GAIT = {"v":3.2827,"cad":2.8788,"drop":0.0302,"duty":0.2659,"stance":3.8775,"ch":{"thigh":{"lo":-0.4985,"hi":0.7306,"f":[0.5397,-0.1761,0.3856,-0.0237,0.1406,-0.0157,-0.0133,0.0012,-0.0248]},"knee":{"lo":0.3951,"hi":2.136,"f":[0.3313,0.3122,0.2703,0.0337,0.2447,-0.0251,-0.0073,0.0004,-0.0076]},"arm":{"lo":-0.8406,"hi":-0.1912,"f":[0.5051,-0.0188,-0.4614,-0.0091,0.0073,0.0822,-0.0245,0.0035,0.0168]},"elbow":{"lo":1.5752,"hi":2.3669,"f":[0.3991,0.3276,-0.1814,-0.0624,-0.0793,-0.1714,0.0114,-0.0054,0.0018]},"armAbd":{"lo":-0.0254,"hi":0.2436,"f":[0.4782,0.4212,-0.1781,0.0689,-0.0095,-0.0533,-0.0401,-0.0098,0.0274]},"lean":{"lo":0.1052,"hi":0.1497,"f":[0.5478,0.2914,-0.0508,-0.1526,0.1307,-0.0408,0.0062,-0.1182,0.0174]},"tw":{"lo":-0.1181,"hi":0.1709,"f":[0.4837,0.408,-0.3493,-0.0143,-0.0102,0.0098,0.0453,-0.0027,0.0014]},"bob":{"lo":-0.0451,"hi":0.04,"f":[0.531,0.013,0.0444,-0.0797,-0.4595,0.0014,-0.0016,0.0126,-0.0408]}}};
