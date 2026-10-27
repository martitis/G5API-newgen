import { agent } from 'supertest';
import app from '../app.js';
const request = agent(app);

describe("Test the season routes", () => {
  beforeAll(() => {
    return request.get('/auth/steam/return')
      .expect(302);
  });
  it('Should return 404 with no seasons.', () => {
    return request.get('/seasons/')
      .expect(404);
  });
  it('Should create a new season.', () => {
    // Min required data.
    let newSeasonData = [
      {
        name: "Temp Season",
        start_date: new Date().toISOString().slice(0, 10).replace('T', ' ')
      }
    ];
    return request
      .post("/seasons/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newSeasonData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it('Should create a new season again.', () => {
    // Min required data.
    let newSeasonData = [
      {
        name: "Bad Actor Season",
        start_date: new Date().toISOString().slice(0, 10).replace('T', ' ')
      }
    ];
    return request
      .post("/seasons/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newSeasonData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it('Should update the bad actor to allow us to attempt to do malicious things.', () => {
    let updateSeasonData = [
      {
        season_id: 2,
        user_id: 2
      }
    ];
    return request
      .put("/seasons/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updateSeasonData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it('Should let an admin delete a season it does not own.', () => {
    let deleteSeasonData = [
      {
        season_id: 2
      }
    ];
    return request
      .delete("/seasons/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(deleteSeasonData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it('Should return 404 with no seasons.', () => {
    let updateSeasonData = [
      {
        match_id: 3,
        season_id: 1
      }
    ];
    return request
      .put("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updateSeasonData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it('Should delete the second season.', () => {
    let deleteSeasonData = [
      {
        season_id: 1
      }
    ];
    return request
      .delete("/seasons/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(deleteSeasonData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
});
